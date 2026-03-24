const express = require('express')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const claudeCodeHeadersService = require('../../services/claudeCodeHeadersService')
const claudeAccountService = require('../../services/account/claudeAccountService')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const config = require('../../../config/config')

const execFileAsync = promisify(execFile)
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..')

const router = express.Router()

// ==================== Claude Code Headers 管理 ====================

// 获取所有 Claude Code headers
router.get('/claude-code-headers', authenticateAdmin, async (req, res) => {
  try {
    const allHeaders = await claudeCodeHeadersService.getAllAccountHeaders()

    // 获取所有 Claude 账号信息
    const accounts = await claudeAccountService.getAllAccounts()
    const accountMap = {}
    accounts.forEach((account) => {
      accountMap[account.id] = account.name
    })

    // 格式化输出
    const formattedData = Object.entries(allHeaders).map(([accountId, data]) => ({
      accountId,
      accountName: accountMap[accountId] || 'Unknown',
      version: data.version,
      userAgent: data.headers['user-agent'],
      updatedAt: data.updatedAt,
      headers: data.headers
    }))

    return res.json({
      success: true,
      data: formattedData
    })
  } catch (error) {
    logger.error('❌ Failed to get Claude Code headers:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get Claude Code headers', message: error.message })
  }
})

// 🗑️ 清除指定账号的 Claude Code headers
router.delete('/claude-code-headers/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    await claudeCodeHeadersService.clearAccountHeaders(accountId)

    return res.json({
      success: true,
      message: `Claude Code headers cleared for account ${accountId}`
    })
  } catch (error) {
    logger.error('❌ Failed to clear Claude Code headers:', error)
    return res
      .status(500)
      .json({ error: 'Failed to clear Claude Code headers', message: error.message })
  }
})

// ==================== 系统更新检查（基于 Git） ====================

// 执行 git 命令的辅助函数
async function runGit(...args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout.trim()
}

// 版本比较函数
function compareVersions(current, latest) {
  const parseVersion = (v) => {
    const parts = v.split('.').map(Number)
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    }
  }

  const currentV = parseVersion(current)
  const latestV = parseVersion(latest)

  if (currentV.major !== latestV.major) {
    return currentV.major - latestV.major
  }
  if (currentV.minor !== latestV.minor) {
    return currentV.minor - latestV.minor
  }
  return currentV.patch - latestV.patch
}

router.get('/check-updates', authenticateAdmin, async (req, res) => {
  // 读取当前版本
  const versionPath = path.join(PROJECT_ROOT, 'VERSION')
  let currentVersion = '1.0.0'
  try {
    currentVersion = fs.readFileSync(versionPath, 'utf8').trim()
  } catch (err) {
    logger.warn('⚠️ Could not read VERSION file:', err.message)
  }

  try {
    // 从缓存获取
    const cacheKey = 'version_check_cache'
    const cached = await redis.getClient().get(cacheKey)

    if (cached && !req.query.force) {
      const cachedData = JSON.parse(cached)
      const cacheAge = Date.now() - cachedData.timestamp

      // 缓存有效期1小时
      if (cacheAge < 3600000) {
        const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

        return res.json({
          success: true,
          data: {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate,
            releaseInfo: cachedData.releaseInfo,
            cached: true
          }
        })
      }
    }

    // 获取当前分支
    const currentBranch = await runGit('rev-parse', '--abbrev-ref', 'HEAD')

    // 从远端获取最新信息
    await runGit('fetch', 'origin', currentBranch)

    // 获取本地和远端的 commit hash
    const localHash = await runGit('rev-parse', 'HEAD')
    const remoteHash = await runGit('rev-parse', `origin/${currentBranch}`)

    // 读取远端 VERSION 文件内容
    let latestVersion = currentVersion
    try {
      latestVersion = await runGit('show', `origin/${currentBranch}:VERSION`)
      latestVersion = latestVersion.trim()
    } catch {
      // 远端没有 VERSION 文件时使用当前版本
    }

    const hasUpdate = localHash !== remoteHash && compareVersions(currentVersion, latestVersion) < 0

    // 获取待更新的 commit 列表（最多显示 20 条）
    let pendingCommits = []
    if (localHash !== remoteHash) {
      try {
        const logOutput = await runGit(
          'log',
          '--oneline',
          '--format=%H|%s|%ai',
          '-20',
          `${localHash}..origin/${currentBranch}`
        )
        if (logOutput) {
          pendingCommits = logOutput.split('\n').map((line) => {
            const [hash, subject, date] = line.split('|')
            return { hash: hash.slice(0, 8), subject, date }
          })
        }
      } catch {
        // ignore
      }
    }

    const releaseInfo = {
      name: latestVersion !== currentVersion ? `v${latestVersion}` : null,
      body: pendingCommits.length
        ? `${pendingCommits.length} 个新提交待更新:\n${pendingCommits.map((c) => `• ${c.subject}`).join('\n')}`
        : '已是最新',
      publishedAt: pendingCommits.length ? pendingCommits[0].date : new Date().toISOString(),
      localHash: localHash.slice(0, 8),
      remoteHash: remoteHash.slice(0, 8),
      branch: currentBranch,
      pendingCommits
    }

    // 缓存结果
    await redis.getClient().set(
      cacheKey,
      JSON.stringify({
        latest: latestVersion,
        releaseInfo,
        timestamp: Date.now()
      }),
      'EX',
      3600
    )

    return res.json({
      success: true,
      data: {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate,
        releaseInfo,
        cached: false
      }
    })
  } catch (error) {
    logger.error('❌ Failed to check for updates:', error.message)

    // 网络错误时尝试返回缓存
    const cacheKey = 'version_check_cache'
    const cached = await redis.getClient().get(cacheKey)

    if (cached) {
      const cachedData = JSON.parse(cached)
      const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

      return res.json({
        success: true,
        data: {
          current: currentVersion,
          latest: cachedData.latest,
          hasUpdate,
          releaseInfo: cachedData.releaseInfo,
          cached: true,
          warning: 'Using cached data due to git error'
        }
      })
    }

    return res.json({
      success: true,
      data: {
        current: currentVersion,
        latest: currentVersion,
        hasUpdate: false,
        releaseInfo: {
          name: 'Update check failed',
          body: `无法检查更新: ${error.message || 'Unknown error'}`,
          publishedAt: new Date().toISOString()
        },
        error: true,
        warning: error.message || 'Failed to check for updates'
      }
    })
  }
})

// 执行更新（git pull + npm install）
router.post('/perform-update', authenticateAdmin, async (req, res) => {
  try {
    const currentBranch = await runGit('rev-parse', '--abbrev-ref', 'HEAD')
    const beforeHash = await runGit('rev-parse', 'HEAD')

    // 读取更新前版本
    const versionPath = path.join(PROJECT_ROOT, 'VERSION')
    let beforeVersion = '1.0.0'
    try {
      beforeVersion = fs.readFileSync(versionPath, 'utf8').trim()
    } catch {
      // ignore
    }

    // 执行 git pull
    const pullOutput = await runGit('pull', 'origin', currentBranch)

    const afterHash = await runGit('rev-parse', 'HEAD')

    // 读取更新后版本
    let afterVersion = beforeVersion
    try {
      afterVersion = fs.readFileSync(versionPath, 'utf8').trim()
    } catch {
      // ignore
    }

    const updated = beforeHash !== afterHash

    // 如果有更新，执行 npm install
    let npmOutput = ''
    if (updated) {
      try {
        const { stdout } = await execFileAsync('npm', ['install', '--omit=dev'], {
          cwd: PROJECT_ROOT,
          timeout: 120000,
          env: process.env,
          shell: true
        })
        npmOutput = stdout.trim()
      } catch (npmErr) {
        logger.warn('⚠️ npm install warning:', npmErr.message)
        npmOutput = `npm install completed with warnings: ${npmErr.message}`
      }

      // 清除版本检查缓存
      await redis.getClient().del('version_check_cache')
    }

    logger.info(
      `✅ System update ${updated ? 'completed' : 'no changes'}: ${beforeHash.slice(0, 8)} → ${afterHash.slice(0, 8)}`
    )

    return res.json({
      success: true,
      data: {
        updated,
        beforeVersion,
        afterVersion,
        beforeHash: beforeHash.slice(0, 8),
        afterHash: afterHash.slice(0, 8),
        branch: currentBranch,
        pullOutput,
        npmOutput: npmOutput ? npmOutput.slice(0, 500) : '',
        needRestart: updated
      }
    })
  } catch (error) {
    logger.error('❌ Failed to perform update:', error.message)
    return res.status(500).json({
      success: false,
      message: `更新失败: ${error.message}`
    })
  }
})

// ==================== OEM 设置管理 ====================

// 获取OEM设置（公开接口，用于显示）
// 注意：这个端点没有 authenticateAdmin 中间件，因为前端登录页也需要访问
router.get('/oem-settings', async (req, res) => {
  try {
    const client = redis.getClient()
    const oemSettings = await client.get('oem:settings')

    // 默认设置
    const defaultSettings = {
      siteName: 'Claude Relay Service',
      siteIcon: '',
      siteIconData: '', // Base64编码的图标数据
      showAdminButton: true, // 是否显示管理后台按钮
      apiStatsNotice: {
        enabled: false,
        title: '',
        content: ''
      },
      updatedAt: new Date().toISOString()
    }

    let settings = defaultSettings
    if (oemSettings) {
      try {
        settings = { ...defaultSettings, ...JSON.parse(oemSettings) }
      } catch (err) {
        logger.warn('⚠️ Failed to parse OEM settings, using defaults:', err.message)
      }
    }

    // 添加 LDAP 启用状态到响应中
    return res.json({
      success: true,
      data: {
        ...settings,
        ldapEnabled: config.ldap && config.ldap.enabled === true
      }
    })
  } catch (error) {
    logger.error('❌ Failed to get OEM settings:', error)
    return res.status(500).json({ error: 'Failed to get OEM settings', message: error.message })
  }
})

// 更新OEM设置
router.put('/oem-settings', authenticateAdmin, async (req, res) => {
  try {
    const { siteName, siteIcon, siteIconData, showAdminButton, apiStatsNotice } = req.body

    // 验证输入
    if (!siteName || typeof siteName !== 'string' || siteName.trim().length === 0) {
      return res.status(400).json({ error: 'Site name is required' })
    }

    if (siteName.length > 100) {
      return res.status(400).json({ error: 'Site name must be less than 100 characters' })
    }

    // 验证图标数据大小（如果是base64）
    if (siteIconData && siteIconData.length > 500000) {
      // 约375KB
      return res.status(400).json({ error: 'Icon file must be less than 350KB' })
    }

    // 验证图标URL（如果提供）
    if (siteIcon && !siteIconData) {
      // 简单验证URL格式
      try {
        new URL(siteIcon)
      } catch (err) {
        return res.status(400).json({ error: 'Invalid icon URL format' })
      }
    }

    const settings = {
      siteName: siteName.trim(),
      siteIcon: (siteIcon || '').trim(),
      siteIconData: (siteIconData || '').trim(), // Base64数据
      showAdminButton: showAdminButton !== false, // 默认为true
      apiStatsNotice: {
        enabled: apiStatsNotice?.enabled === true,
        title: (apiStatsNotice?.title || '').trim().slice(0, 100),
        content: (apiStatsNotice?.content || '').trim().slice(0, 2000)
      },
      updatedAt: new Date().toISOString()
    }

    const client = redis.getClient()
    await client.set('oem:settings', JSON.stringify(settings))

    logger.info(`✅ OEM settings updated: ${siteName}`)

    return res.json({
      success: true,
      message: 'OEM settings updated successfully',
      data: settings
    })
  } catch (error) {
    logger.error('❌ Failed to update OEM settings:', error)
    return res.status(500).json({ error: 'Failed to update OEM settings', message: error.message })
  }
})

// ==================== Claude Code 版本管理 ====================

router.get('/claude-code-version', authenticateAdmin, async (req, res) => {
  try {
    const CACHE_KEY = 'claude_code_user_agent:daily'

    // 获取缓存的统一User-Agent
    const unifiedUserAgent = await redis.client.get(CACHE_KEY)
    const ttl = unifiedUserAgent ? await redis.client.ttl(CACHE_KEY) : 0

    res.json({
      success: true,
      userAgent: unifiedUserAgent,
      isActive: !!unifiedUserAgent,
      ttlSeconds: ttl,
      lastUpdated: unifiedUserAgent ? new Date().toISOString() : null
    })
  } catch (error) {
    logger.error('❌ Get unified Claude Code User-Agent error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to get User-Agent information',
      error: error.message
    })
  }
})

// 🗑️ 清除统一Claude Code User-Agent缓存
router.post('/claude-code-version/clear', authenticateAdmin, async (req, res) => {
  try {
    const CACHE_KEY = 'claude_code_user_agent:daily'

    // 删除缓存的统一User-Agent
    await redis.client.del(CACHE_KEY)

    logger.info(`🗑️ Admin manually cleared unified Claude Code User-Agent cache`)

    res.json({
      success: true,
      message: 'Unified User-Agent cache cleared successfully'
    })
  } catch (error) {
    logger.error('❌ Clear unified User-Agent cache error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to clear cache',
      error: error.message
    })
  }
})

// ==================== 模型价格管理 ====================

const pricingService = require('../../services/pricingService')

// 获取所有模型价格数据
router.get('/models/pricing', authenticateAdmin, async (req, res) => {
  try {
    if (!pricingService.pricingData || Object.keys(pricingService.pricingData).length === 0) {
      await pricingService.loadPricingData()
    }
    const data = pricingService.pricingData
    res.json({
      success: true,
      data: data || {}
    })
  } catch (error) {
    logger.error('Failed to get model pricing:', error)
    res.status(500).json({ error: 'Failed to get model pricing', message: error.message })
  }
})

// 获取价格服务状态
router.get('/models/pricing/status', authenticateAdmin, async (req, res) => {
  try {
    const status = pricingService.getStatus()
    res.json({ success: true, data: status })
  } catch (error) {
    logger.error('Failed to get pricing status:', error)
    res.status(500).json({ error: 'Failed to get pricing status', message: error.message })
  }
})

// 强制刷新价格数据
router.post('/models/pricing/refresh', authenticateAdmin, async (req, res) => {
  try {
    const result = await pricingService.forceUpdate()
    res.json({ success: result.success, message: result.message })
  } catch (error) {
    logger.error('Failed to refresh pricing:', error)
    res.status(500).json({ error: 'Failed to refresh pricing', message: error.message })
  }
})

module.exports = router
