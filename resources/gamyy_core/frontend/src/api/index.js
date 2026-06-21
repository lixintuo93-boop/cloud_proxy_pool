import axios from 'axios'
import { ElMessage } from 'element-plus'

const http = axios.create({ baseURL: '/api', timeout: 15000 })

http.interceptors.response.use(
  res => res.data,
  err => {
    const msg = err.response?.data?.error || err.message || '请求失败'
    ElMessage.error(msg)
    return Promise.reject(err)
  }
)

// ── 系统配置 ──────────────────────────────────────────────
export const getSystemConfig  = ()       => http.get('/system-config')
export const saveSystemConfig = (data)   => http.put('/system-config', data)
export const getHeartbeatEndpoints = ()  => http.get('/system-config/heartbeat-endpoints')

// ── 账号（顶级）──────────────────────────────────────────
export const getAccounts         = (params)   => http.get('/accounts', { params })
export const updateAccount       = (id, data) => http.put(`/accounts/${id}`, data)
export const deleteAccount       = (id)       => http.delete(`/accounts/${id}`)
export const setAccountEnabled   = (id, en)   => http.patch(`/accounts/${id}/enabled`, { enabled: en })
export const getAccountPatients  = (id)       => http.get(`/accounts/${id}/patients`)

// ── 账号操作 ──────────────────────────────────────────────
export const executeAccountOperation = (id, operationType, options) =>
  http.post(`/accounts/${id}/operation`, { operationType, options }, { timeout: 180000 })
export const getAccountSourceRecords = (id) => http.get(`/accounts/${id}/source-records`)
export const getAccountMessages      = (id) => http.get(`/accounts/${id}/messages`)
export const getAccountRequestLogs   = (id, params) => http.get(`/accounts/${id}/request-logs`, { params })
export const generateAccounts        = (data) => http.post('/accounts/generate', data)
export const addManualAccount        = (data) => http.post('/accounts/add-manual', data)
export const generatePatientInfo     = (minAge, maxAge, gender) => http.get('/accounts/generate-patient-info', { params: { minAge, maxAge, ...(gender ? { gender } : {}) } })

// ── 任务 ──────────────────────────────────────────────────
export const getTasks            = (params)   => http.get('/tasks', { params })
export const createTask          = (data)     => http.post('/tasks', data)
export const getTask             = (id)       => http.get(`/tasks/${id}`)
export const updateTask          = (id, data) => http.put(`/tasks/${id}`, data)
export const deleteTask          = (id)       => http.delete(`/tasks/${id}`)
export const setTaskEnabled      = (id, en)   => http.patch(`/tasks/${id}/enabled`, { enabled: en })

// ── 代理模板 ──────────────────────────────────────────────
export const getProxyTemplates   = ()         => http.get('/proxy-templates')
export const createProxyTemplate = (data)     => http.post('/proxy-templates', data)
export const updateProxyTemplate = (id, data) => http.put(`/proxy-templates/${id}`, data)
export const deleteProxyTemplate = (id)       => http.delete(`/proxy-templates/${id}`)

// ── TLS 指纹 ──────────────────────────────────────────────
export const getFingerprints     = ()         => http.get('/fingerprints')

// ── 代理池 ────────────────────────────────────────────────
export const getProxies          = (params)   => http.get('/proxies', { params })
export const syncProxies         = ()         => http.post('/proxies/sync')
export const setProxyEnabled     = (id, en)   => http.patch(`/proxies/${id}/enabled`, { enabled: en })
export const applyProxyTemplate  = (id, tId)  => http.patch(`/proxies/${id}/template`, { templateId: tId })
export const batchApplyProxyTemplate = (accountId, templateId) => http.post('/proxies/batch/apply-template', { accountId, templateId })
export const updateProxyConfig   = (id, data) => http.put(`/proxies/${id}/config`, data)
export const assignProxy         = (id, accountId) => http.post(`/proxies/${id}/assign`, { accountId })
export const unassignProxy       = (id)            => http.post(`/proxies/${id}/unassign`)
export const deleteProxy         = (id)            => http.delete(`/proxies/${id}`)
export const batchAssign         = (ids, accountId)=> http.post('/proxies/batch/assign', { ids, accountId })
export const batchUnassign       = (ids)           => http.post('/proxies/batch/unassign', { ids })
export const batchSetProxyEnabled= (ids, en)       => http.patch('/proxies/batch/enabled', { ids, enabled: en })
export const autoAssignProxies   = (accountId)     => http.post(`/proxies/${accountId}/auto-assign`)
export const previewAutoAssign   = (accountId)     => http.get(`/proxies/${accountId}/auto-assign/preview`)
export const autoAssignAll       = ()              => http.post('/proxies/auto-assign-all')
export const autoAssignOpsAll    = ()              => http.post('/proxies/auto-assign-ops-all')
export const rebalanceProxies    = ()              => http.post('/proxies/rebalance')
export const previewRebalance    = ()              => http.get('/proxies/rebalance/preview')
export const setAccountOpsProxy  = (id, proxyId)   => http.patch(`/accounts/${id}/ops-proxy`, { proxyId })

// ── 任务控制 ──────────────────────────────────────────────
export const startTask           = (id)   => http.post(`/tasks/${id}/start`, null, { timeout: 600000 })
export const stopTask            = (id)   => http.post(`/tasks/${id}/stop`, null, { timeout: 120000 })
export const getTaskStatus       = (id)   => http.get(`/tasks/${id}/status`)
export const getRunningTasks     = ()     => http.get('/tasks/running')
export const getTaskProxies      = (id)   => http.get(`/tasks/${id}/proxies`)
export const getTaskProxyStats   = (id)   => http.get(`/tasks/${id}/proxy-stats`)

// ── 日志 ──────────────────────────────────────────────────
export const getLogs             = (type, params) => http.get(`/logs/${type}`, { params })
export const getTaskStats        = (id)           => http.get(`/logs/stats/tasks/${id}`)

// ── 参考数据 ──────────────────────────────────────────────
export const getDoctors          = ()  => http.get('/doctors')
export const getProxySources     = ()  => http.get('/proxy-sources')
export const getProxyGroups      = ()  => http.get('/proxy-sources/groups')

// ── 代理池管理（标准代理） ────────────────────────────────
export const getProxyPool          = (params)     => http.get('/proxy-pool', { params })
export const getProxyPoolGroups    = ()           => http.get('/proxy-pool/groups')
export const getProxyPoolStats     = ()           => http.get('/proxy-pool/stats')
export const getProxyPoolPlatforms = ()           => http.get('/proxy-pool/platforms')
export const addProxyEntry         = (data)       => http.post('/proxy-pool', data)
export const batchImportProxies    = (data)       => http.post('/proxy-pool/batch-import', data)
export const importFromDb          = (data)       => http.post('/proxy-pool/import-db', data)
export const updateProxyEntry      = (id, data)   => http.put(`/proxy-pool/${id}`, data)
export const deleteProxyEntry      = (id)         => http.delete(`/proxy-pool/${id}`)
export const batchOpsProxy         = (data)       => http.post('/proxy-pool/batch-ops', data)
export const testProxyEntry        = (id)         => http.post(`/proxy-pool/${id}/test`, {}, { timeout: 20000 })
export const startBatchTest        = (ids)        => http.post('/proxy-pool/batch-test', { ids })
export const queryAfdEntry         = (id, opts)   => http.post(`/proxy-pool/${id}/afd`, opts || {}, { timeout: 90000 })
export const startBatchAfd         = (ids, useProxy) => http.post('/proxy-pool/batch-afd', { ids, useProxy })
export const getProxyJob           = (jobId)      => http.get(`/proxy-pool/jobs/${jobId}`)
export const getSshProxyStats      = ()           => http.get('/proxy-pool/stats', { params: { type: 'ssh' } })
export const sshSyncFromDb         = (dbPath)     => http.post('/proxy-pool/ssh-sync', { dbPath })
export const sshBatchImport        = (text, group_name, platform) => http.post('/proxy-pool/ssh-batch-import', { text, group_name, platform })
export const addDirectProxy        = ()           => http.post('/proxy-pool/add-direct', {}, { timeout: 20000 })
export const setProxyCloudAgent    = (id, url)    => http.patch(`/proxy-pool/${id}/cloud-agent`, { cloud_agent_url: url })
export const checkProxyCloudAgent  = (id)         => http.get(`/proxy-pool/${id}/cloud-agent/health`, { timeout: 12000 })
export const batchCheckCloudAgents = (ids)        => http.post('/proxy-pool/batch-check-agents', { ids }, { timeout: 30000 })
export const autoFillAgentUrls     = ()           => http.post('/proxy-pool/auto-fill-agent-urls')

// ── 注册（App端 3 步流程）────────────────────────────────────
export const createRegisterSession = (platform) => http.post('/register/session', { platform })
export const getRegisterCaptcha    = (sessionId) => http.get(`/register/captcha/${sessionId}`)
export const sendRegisterSms       = (data)      => http.post('/register/send-sms', data)
export const submitRegister        = (data)      => http.post('/register/submit', data, { timeout: 30000 })
export const cancelRegisterSession = (sessionId) => http.delete(`/register/session/${sessionId}`)
