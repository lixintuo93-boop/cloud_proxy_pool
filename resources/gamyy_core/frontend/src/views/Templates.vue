<template>
  <MainLayout>
    <div class="tmpl-toolbar">
      <h3 style="margin:0">代理配置模板</h3>
      <el-button type="primary" :icon="Plus" @click="openTmpl()">新建模板</el-button>
    </div>

    <div v-loading="loading" class="tmpl-grid">
      <div v-for="row in templates" :key="row.id" class="tmpl-card">
        <div class="tmpl-card-header">
          <div class="tmpl-card-title">
            {{ row.name }}
            <el-tag v-if="row.name === '默认配置'" size="small" type="warning" style="margin-left:6px;font-size:11px">默认</el-tag>
          </div>
          <div v-if="row.description" class="tmpl-card-desc">{{ row.description }}</div>
          <div class="tmpl-card-desc" style="margin-top:2px">指纹：{{ fpLabel(row.fingerprint_config?.name) }}</div>
        </div>

        <div class="tmpl-card-body">
          <div class="tmpl-section">
            <div class="tmpl-section-title">通道</div>
            <div class="tmpl-kv">
              <span class="k">建通道</span><span class="v mono">{{ row.channel_build_overrides?.startTime || '—' }}</span>
              <span class="k">窗口</span><span class="v">{{ msToSec(row.channel_build_overrides?.windowTime) || '—' }}</span>
              <span class="k">尝试</span><span class="v">{{ row.channel_build_overrides?.attempts ?? '—' }} 次</span>
              <span class="k">分布</span><span class="v">{{ row.channel_build_overrides?.distribution === 'random' ? '随机' : '均匀' }}</span>
              <span class="k">早停</span>
              <span class="v" :style="row.channel_build_overrides?.earlyStop?.enabled ? 'color:#67c23a' : 'color:#c0c4cc'">
                {{ row.channel_build_overrides?.earlyStop?.enabled ? '✓' : '✗' }}
              </span>
              <span class="k">自关</span>
              <span class="v" :style="row.channel_build_overrides?.autoCloseExcess?.enabled ? 'color:#67c23a' : 'color:#c0c4cc'">
                {{ row.channel_build_overrides?.autoCloseExcess?.enabled ? '✓' : '✗' }}
              </span>
              <span class="k">最大</span><span class="v">{{ fmtMaxChannels(row.channel_build_overrides?.maxSuccessChannels) }}</span>
            </div>
          </div>

          <div class="tmpl-section">
            <div class="tmpl-section-title">查号</div>
            <div class="tmpl-kv">
              <span class="k">查票</span><span class="v mono">{{ row.check_start_time || '—' }}</span>
              <span class="k">窗口</span><span class="v">{{ msToSec(row.check_window_time) || '—' }}</span>
              <span class="k">间隔</span><span class="v">{{ row.check_min_interval ?? '—' }} ms</span>
              <span class="k">停止</span><span class="v">{{ fmtStopCount(row.check_stop_after_found_count) }}</span>
              <span class="k">模式</span><span class="v">{{ row.check_mode === 'dept' ? '按科室' : '按医生' }}</span>
              <span class="k">复用</span>
              <span class="v" :style="row.check_reuse_channel?.enabled ? 'color:#67c23a' : 'color:#c0c4cc'">
                {{ row.check_reuse_channel?.enabled ? '✓' : '✗' }}
              </span>
              <span class="k">复间</span>
              <span class="v" :style="row.check_reuse_channel?.enabled ? '' : 'color:#c0c4cc'">{{ msInt(row.check_reuse_channel?.minInterval) }}</span>
            </div>
          </div>

          <div class="tmpl-section">
            <div class="tmpl-section-title">锁号</div>
            <div class="tmpl-kv">
              <span class="k">时机</span><span class="v mono">{{ row.lock_config?.lockStartTime || '立即' }}</span>
              <span class="k">窗口</span><span class="v">{{ msToSec(row.lock_config?.windowTime) || '—' }}</span>
              <span class="k">预留</span><span class="v">{{ row.lock_config?.reservedChannels ?? 0 }} 条</span>
              <span class="k">Sign</span><span class="v">{{ fmtSignStrategy(row.lock_config?.submitSignStrategy) }}</span>
              <span class="k">首延</span><span class="v">{{ msInt(row.lock_config?.firstLockDelayMs) }}</span>
              <span class="k">锁间</span><span class="v">{{ msInt(row.lock_config?.minInterval) }}</span>
            </div>
          </div>

          <div class="tmpl-section">
            <div class="tmpl-section-title">心跳</div>
            <div class="tmpl-kv">
              <span class="k">启用</span>
              <span class="v" :style="row.keepalive_enabled ? 'color:#67c23a' : 'color:#c0c4cc'">
                {{ row.keepalive_enabled ? '✓' : '✗' }}
              </span>
              <span class="k">间隔</span>
              <span class="v" :style="row.keepalive_enabled ? '' : 'color:#c0c4cc'">{{ fmtKaInterval(row.keepalive_interval_min, row.keepalive_interval_max) }}</span>
              <span class="k">类型</span>
              <span class="v" :style="row.keepalive_enabled ? '' : 'color:#c0c4cc'">{{ row.keepalive_request_type === 'systemConfig' ? '模拟业务' : 'HEAD' }}</span>
              <span class="k">端点</span>
              <span class="v" :style="(row.keepalive_enabled && row.keepalive_request_type === 'systemConfig') ? '' : 'color:#c0c4cc'">{{ fmtKaEndpoints(row) }}</span>
              <span class="k">超时</span>
              <span class="v" :style="row.keepalive_enabled ? '' : 'color:#c0c4cc'">{{ msToSec(row.heartbeat_timeout) || '—' }}</span>
              <span class="k">直连</span>
              <span class="v" :style="row.direct_keepalive_enabled ? 'color:#67c23a' : 'color:#c0c4cc'">
                {{ row.direct_keepalive_enabled ? '✓' : '✗' }}
              </span>
            </div>
          </div>
        </div>

        <div class="tmpl-card-footer">
          <el-button link size="small" @click="openTmpl(row)">编辑</el-button>
          <el-button link size="small" @click="copyTmpl(row)">复制</el-button>
          <el-button link size="small" type="danger" :disabled="row.name === '默认配置'" @click="delTmpl(row)">删除</el-button>
        </div>
      </div>
    </div>

    <!-- 模板编辑 -->
    <el-dialog v-model="dialog" :title="editing?.id ? '编辑代理模板' : '新建代理模板'" width="720px">
      <el-form :model="form" label-width="130px">
        <el-form-item label="模板名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="form.description" /></el-form-item>

        <el-tabs type="border-card" style="margin-top:8px">
          <el-tab-pane label="通道配置">
            <el-form-item label="通道开始时间">
              <TimeInput v-model="form.channelCfg.startTime" />
              <span class="tmpl-hint">应早于查票开始时间</span>
            </el-form-item>
            <el-form-item label="创建窗口(ms)">
              <el-input-number v-model="form.channelCfg.windowTime" :min="1000" :step="1000" />
              <span class="tmpl-hint">{{ msToSec(form.channelCfg.windowTime) }}</span>
            </el-form-item>
            <el-form-item label="每代理尝试次数">
              <el-input-number v-model="form.channelCfg.attempts" :min="1" :max="1000" />
            </el-form-item>
            <el-form-item label="时间分布">
              <el-radio-group v-model="form.channelCfg.distribution">
                <el-radio value="uniform">均匀</el-radio>
                <el-radio value="random">随机</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="最大成功通道数">
              <el-input-number v-model="form.channelCfg.maxSuccessChannels" :min="0" :step="1" />
              <span class="tmpl-hint">0 = 不限</span>
            </el-form-item>
            <el-divider>早停策略</el-divider>
            <el-form-item label="启用早停">
              <el-switch v-model="form.earlyStop.enabled" />
            </el-form-item>
            <template v-if="form.earlyStop.enabled">
              <el-form-item label="算法">
                <el-radio-group v-model="form.earlyStop.algorithm">
                  <el-radio value="dynamic">动态（推荐）</el-radio>
                  <el-radio value="fixed">固定阈值</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="form.earlyStop.algorithm === 'dynamic'" label="动态倍数">
                <el-input-number v-model="form.earlyStop.multiplier" :min="1" :step="1" />
              </el-form-item>
              <el-form-item v-else label="固定阈值(ms)">
                <el-input-number v-model="form.earlyStop.fixedThreshold" :min="1000" :step="1000" />
              </el-form-item>
            </template>
            <el-divider>自动关闭多余通道</el-divider>
            <el-form-item label="启用">
              <el-switch v-model="form.autoClose.enabled" />
            </el-form-item>
            <template v-if="form.autoClose.enabled">
              <el-form-item label="最大通道数">
                <el-input v-model="form.autoClose.maxSuccessChannels" placeholder="auto" style="width:100px" />
              </el-form-item>
              <el-form-item label="监控间隔(ms)">
                <el-input-number v-model="form.autoClose.monitorInterval" :min="0" :step="1000" />
              </el-form-item>
            </template>
            <el-divider>目标主机</el-divider>
            <el-form-item label=" " label-width="0">
              <div style="width:100%">
                <p style="color:#909399;font-size:12px;margin:0 0 10px">全不选 = 继承系统配置</p>
                <TargetHostsEditor v-model="form.target_hosts" :systemHosts="systemHosts" />
              </div>
            </el-form-item>
          </el-tab-pane>

          <el-tab-pane label="查号配置">
            <el-form-item label="查票开始时间">
              <TimeInput v-model="form.check_start_time" />
            </el-form-item>
            <el-form-item label="查票窗口(ms)">
              <el-input-number v-model="form.check_window_time" :min="1000" :step="1000" />
              <span class="tmpl-hint">{{ msToSec(form.check_window_time) }}</span>
            </el-form-item>
            <el-form-item label="最小间隔(ms)">
              <el-input-number v-model="form.check_min_interval" :min="50" :step="50" />
            </el-form-item>
            <el-form-item label="时间分布">
              <el-radio-group v-model="form.check_distribution">
                <el-radio value="uniform">均匀</el-radio>
                <el-radio value="random">随机</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="查到几次后停止">
              <el-input-number v-model="form.check_stop_after_found_count" :min="0" :step="1" style="width:120px" />
              <span class="tmpl-hint">0=永不停止；建议3</span>
            </el-form-item>
            <el-divider>查票模式</el-divider>
            <el-form-item label="查票模式">
              <el-radio-group v-model="form.check_mode">
                <el-radio value="doctor">按医生查票</el-radio>
                <el-radio value="dept">按科室查票</el-radio>
              </el-radio-group>
            </el-form-item>
            <template v-if="form.check_mode === 'doctor'">
              <el-form-item label="医生来源">
                <el-radio-group v-model="form.doctor_source">
                  <el-radio value="config">配置固定医生</el-radio>
                  <el-radio value="dynamic">动态获取</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="form.doctor_source === 'config'" label="医生代码">
                <div>
                  <el-tag v-for="(code, i) in form.doctor_codes" :key="i" closable @close="form.doctor_codes.splice(i, 1)" style="margin:2px 4px 2px 0">{{ code }}</el-tag>
                  <el-input v-model="newDoctorCode" placeholder="输入代码回车添加" size="small" style="width:160px;margin-top:4px" @keyup.enter="addDoctorCode">
                    <template #append><el-button @click="addDoctorCode">添加</el-button></template>
                  </el-input>
                </div>
              </el-form-item>
              <el-form-item label="选取方式">
                <el-radio-group v-model="form.doctor_select_mode">
                  <el-radio value="random">随机</el-radio>
                  <el-radio value="sequential">顺序</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="排班开始日期">
                <el-date-picker v-model="form.doctor_plan_date_start" type="date" value-format="YYYY-MM-DD" placeholder="留空=不限" clearable />
              </el-form-item>
            </template>
            <template v-else>
              <el-form-item label="科室代码">
                <el-input v-model="form.dept_code" placeholder="输入科室代码" style="width:200px" />
              </el-form-item>
              <el-form-item label="排班开始日期">
                <el-date-picker v-model="form.dept_plan_date_start" type="date" value-format="YYYY-MM-DD" placeholder="留空=不限" clearable />
              </el-form-item>
              <el-form-item label="排班结束日期">
                <el-date-picker v-model="form.dept_plan_date_end" type="date" value-format="YYYY-MM-DD" placeholder="留空=不限" clearable />
              </el-form-item>
            </template>
            <el-divider>通道复用</el-divider>
            <el-form-item label="启用复用">
              <el-switch v-model="form.reuseChannel.enabled" />
            </el-form-item>
            <template v-if="form.reuseChannel.enabled">
              <el-form-item label="最小复用间隔(ms)">
                <el-input-number v-model="form.reuseChannel.minInterval" :min="0" :step="100" />
              </el-form-item>
              <el-form-item label="超时后复用">
                <el-switch v-model="form.reuseChannel.reuseOnTimeout" />
              </el-form-item>
              <el-form-item label="报错后复用">
                <el-switch v-model="form.reuseChannel.reuseOnError" />
              </el-form-item>
            </template>
          </el-tab-pane>

          <el-tab-pane label="锁号配置">
            <el-form-item label="预留通道数">
              <el-input-number v-model="form.lockCfg.reservedChannels" :min="0" />
            </el-form-item>
            <el-form-item label="锁号开始时间">
              <div>
                <el-radio-group v-model="lockMode">
                  <el-radio value="immediate">查到票立即开始</el-radio>
                  <el-radio value="scheduled">指定时间</el-radio>
                </el-radio-group>
                <div v-if="lockMode === 'scheduled'" style="margin-top:8px;display:flex;align-items:center;gap:8px">
                  <TimeInput v-model="form.lockCfg.lockStartTime" />
                </div>
              </div>
            </el-form-item>
            <el-form-item label="首次锁号延迟(ms)">
              <el-input-number v-model="form.lockCfg.firstLockDelayMs" :min="0" />
            </el-form-item>
            <el-form-item label="锁号窗口(ms)">
              <el-input-number v-model="form.lockCfg.windowTime" :min="1000" :step="1000" />
              <span class="tmpl-hint">{{ msToSec(form.lockCfg.windowTime) }}</span>
            </el-form-item>
            <el-form-item label="最小锁号间隔(ms)">
              <el-input-number v-model="form.lockCfg.minInterval" :min="0" />
            </el-form-item>
            <el-form-item label="无通道时直连">
              <el-switch v-model="form.lockCfg.directRequestOnNoChannel" />
            </el-form-item>
            <el-form-item label="SubmitSign策略">
              <el-select v-model="form.lockCfg.submitSignStrategy" style="width:160px">
                <el-option value="first"  label="使用最先获取的" />
                <el-option value="latest" label="使用最新获取的" />
                <el-option value="rotate" label="轮换使用（推荐）" />
              </el-select>
            </el-form-item>
          </el-tab-pane>

          <el-tab-pane label="心跳保活">
            <el-form-item label="启用心跳">
              <el-switch v-model="form.keepalive_enabled" :active-value="1" :inactive-value="0" />
            </el-form-item>
            <template v-if="form.keepalive_enabled">
              <el-form-item label="心跳超时(ms)">
                <el-input-number v-model="form.heartbeat_timeout" :min="1000" :step="1000" />
                <span class="tmpl-hint">{{ msToSec(form.heartbeat_timeout) }}</span>
              </el-form-item>
              <el-form-item label="心跳间隔范围(ms)">
                <el-input-number v-model="form.keepalive_interval_min" :min="1000" :step="1000" style="width:140px" />
                <span style="margin:0 8px;color:#909399">~</span>
                <el-input-number v-model="form.keepalive_interval_max" :min="1000" :step="1000" style="width:140px" />
                <span class="tmpl-hint">每次心跳在区间内随机抽一个间隔</span>
              </el-form-item>
              <el-form-item label="心跳类型">
                <el-radio-group v-model="form.keepalive_request_type">
                  <el-radio value="head">HEAD（轻量）</el-radio>
                  <el-radio value="systemConfig">模拟业务（随机抽端点）</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="form.keepalive_request_type === 'systemConfig'" label="启用的业务端点">
                <div style="width:100%">
                  <div style="color:#909399;font-size:12px;margin-bottom:6px">勾选的 endpoint 进入抽样池；每次心跳随机选 1 条发出。空 = 全启用。</div>
                  <div style="display:flex;flex-wrap:wrap;gap:4px 16px">
                    <el-checkbox
                      v-for="ep in heartbeatEndpoints"
                      :key="ep.id"
                      :model-value="form.keepalive_business_endpoints.includes(ep.id)"
                      @update:model-value="toggleEndpoint(ep.id, $event)"
                    >
                      <span style="font-size:13px">{{ ep.name }}</span>
                      <span style="color:#909399;font-size:11px;margin-left:4px">{{ ep.path }}</span>
                    </el-checkbox>
                  </div>
                  <div style="color:#909399;font-size:12px;margin-top:6px">
                    当前启用 {{ form.keepalive_business_endpoints.length }} / {{ heartbeatEndpoints.length }} 条
                    <el-button link type="primary" size="small" @click="toggleAllEndpoints(true)">全选</el-button>
                    <el-button link size="small" @click="toggleAllEndpoints(false)">清空</el-button>
                  </div>
                </div>
              </el-form-item>
              <el-form-item label="启用直连TCP保活">
                <el-switch v-model="form.direct_keepalive_enabled" :active-value="1" :inactive-value="0" />
                <span class="tmpl-hint">仅对直连模式(proxyType=direct)生效</span>
              </el-form-item>
            </template>
          </el-tab-pane>

          <el-tab-pane label="TLS指纹">
            <el-form-item label="TLS 指纹">
              <el-select v-model="form.fingerprint_name" style="width:300px">
                <el-option
                  v-for="fp in fingerprints"
                  :key="fp.name"
                  :value="fp.name"
                  :label="fp.label + (fp.isDefault ? '（默认）' : '')"
                />
              </el-select>
            </el-form-item>
            <el-form-item v-if="selectedFp" label=" " label-width="0">
              <div style="width:100%;color:#606266;font-size:12px;line-height:1.9">
                <div>来源：{{ selectedFp.source || '—' }}</div>
                <div>模式：{{ selectedFp.mode }} ｜ ALPN：{{ (selectedFp.alpn || []).join(', ') || '—' }}</div>
                <div style="font-family:monospace">JA3：{{ selectedFp.ja3 || '（每连随机/见 JA4）' }}</div>
                <div style="font-family:monospace">JA4：{{ selectedFp.ja4 || '—' }}</div>
                <div style="color:#909399;margin-top:8px">
                  指纹由 fp-sidecar 施加。需在运行 gamyy-core 时设置环境变量 FP_SIDECAR_ADDR（如 127.0.0.1:8788）并启动 sidecar 才生效；
                  未设置则走 Node 原生 TLS（指纹无效）。account 走 HTTP/1.1，建议用 android_app。
                </div>
              </div>
            </el-form-item>
          </el-tab-pane>
        </el-tabs>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="saveTmpl">保存</el-button>
      </template>
    </el-dialog>
  </MainLayout>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import MainLayout from '@/layout/MainLayout.vue'
import TimeInput from '@/components/TimeInput.vue'
import TargetHostsEditor from '@/components/TargetHostsEditor.vue'
import { getProxyTemplates, createProxyTemplate, updateProxyTemplate, deleteProxyTemplate, getSystemConfig, getHeartbeatEndpoints, getFingerprints } from '@/api'
import { isTimeString, isValidMaxChannels } from '@/utils/validate'

const loading = ref(false)
const templates = ref([])
const systemHosts = ref([])
const dialog = ref(false)
const editing = ref(null)
const lockMode = ref('immediate')
const newDoctorCode = ref('')
const heartbeatEndpoints = ref([])
const fingerprints = ref([])
const selectedFp = computed(() => fingerprints.value.find(f => f.name === form.fingerprint_name) || null)
function fpLabel(name) {
  const n = name || 'android_app'
  const fp = fingerprints.value.find(f => f.name === n)
  return fp ? fp.label : n
}

function toggleEndpoint(id, checked) {
  const set = new Set(form.keepalive_business_endpoints)
  if (checked) set.add(id); else set.delete(id)
  form.keepalive_business_endpoints = Array.from(set)
}
function toggleAllEndpoints(all) {
  form.keepalive_business_endpoints = all ? heartbeatEndpoints.value.map(e => e.id) : []
}

function parseField(field) {
  if (typeof field === 'object' && field !== null) return field
  if (typeof field === 'string') { try { return JSON.parse(field) } catch { return {} } }
  return {}
}

const form = reactive({
  name: '', description: '',
  check_start_time: '', check_window_time: 10000, check_min_interval: 250,
  check_distribution: 'uniform', check_stop_after_found_count: 3,
  reuseChannel: { enabled: false, minInterval: 1000, reuseOnTimeout: false, reuseOnError: false },
  lockCfg: { reservedChannels: 0, lockStartTime: '', firstLockDelayMs: 0, windowTime: 20000, minInterval: 250, directRequestOnNoChannel: false, submitSignStrategy: 'rotate' },
  channelCfg: { startTime: '', windowTime: 270000, attempts: 200, distribution: 'uniform', maxSuccessChannels: 0 },
  earlyStop: { enabled: true, algorithm: 'dynamic', multiplier: 15, fixedThreshold: 20000 },
  autoClose: { enabled: true, maxSuccessChannels: 'auto', monitorInterval: 0 },
  target_hosts: [],
  check_mode: 'doctor',
  doctor_source: 'config',
  doctor_select_mode: 'random',
  doctor_codes: [],
  doctor_plan_date_start: null,
  dept_code: '',
  dept_plan_date_start: null,
  dept_plan_date_end: null,
  // 心跳/keepAlive
  keepalive_enabled: 1,
  keepalive_interval_min: 40000,
  keepalive_interval_max: 70000,
  keepalive_request_type: 'head',
  keepalive_business_endpoints: [],
  direct_keepalive_enabled: 0,
  heartbeat_timeout: 300000,
  // TLS 指纹（按名引用 services/fingerprints.js 注册表）
  fingerprint_name: 'android_app',
})

function addDoctorCode() {
  const code = newDoctorCode.value.trim()
  if (code && !form.doctor_codes.includes(code)) form.doctor_codes.push(code)
  newDoctorCode.value = ''
}

function msToSec(ms) {
  if (!ms) return ''
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${(ms / 1000).toFixed(1)} 秒`
}

function fmtStopCount(n) {
  if (n == null) return '—'
  if (n === 0) return '不停止'
  return `${n} 次`
}

function fmtSignStrategy(s) {
  if (s === 'first')  return '最先'
  if (s === 'latest') return '最新'
  if (s === 'rotate') return '轮换'
  return s || '—'
}

function fmtMaxChannels(n) {
  if (n == null) return '—'
  if (n === 0) return '不限'
  return `${n} 条`
}

function msInt(ms) {
  if (ms == null) return '—'
  return `${ms} ms`
}

// 心跳间隔区间，按秒展示（如 "40~70 秒"）
function fmtKaInterval(min, max) {
  if (min == null || max == null) return '—'
  const s = (ms) => Number.isInteger(ms / 1000) ? ms / 1000 : (ms / 1000).toFixed(1)
  return min === max ? `${s(min)} 秒` : `${s(min)}~${s(max)} 秒`
}

// 心跳业务端点：仅"模拟业务"类型有意义；0 条 = 全启用
function fmtKaEndpoints(row) {
  if (row.keepalive_request_type !== 'systemConfig') return '—'
  const n = Array.isArray(row.keepalive_business_endpoints) ? row.keepalive_business_endpoints.length : 0
  return n === 0 ? '全部' : `${n} 条`
}

async function loadAll() {
  loading.value = true
  try {
    const [t, sys, ep, fp] = await Promise.all([getProxyTemplates(), getSystemConfig(), getHeartbeatEndpoints(), getFingerprints()])
    templates.value = t.data
    systemHosts.value = Array.isArray(sys.data?.target_hosts) ? sys.data.target_hosts : []
    heartbeatEndpoints.value = Array.isArray(ep.data) ? ep.data : []
    fingerprints.value = Array.isArray(fp.data?.list) ? fp.data.list : []
  } finally { loading.value = false }
}

function openTmpl(row = null) {
  editing.value = row
  const src = row || templates.value.find(t => t.name === '默认配置')
  const cb = parseField(src?.channel_build_overrides)
  const lk = parseField(src?.lock_config)
  const rc = parseField(src?.check_reuse_channel)
  const srcDoctorCodes = Array.isArray(src?.doctor_codes) ? src.doctor_codes : []
  Object.assign(form, {
    name: row?.name || '',
    description: row?.description || '',
    check_start_time: src?.check_start_time || '',
    check_window_time: src?.check_window_time || 10000,
    check_min_interval: src?.check_min_interval || 250,
    check_distribution: src?.check_distribution || 'uniform',
    check_stop_after_found_count: src?.check_stop_after_found_count ?? 3,
    check_mode: src?.check_mode || 'doctor',
    doctor_source: src?.doctor_source || 'config',
    doctor_select_mode: src?.doctor_select_mode || 'random',
    doctor_codes: [...srcDoctorCodes],
    doctor_plan_date_start: src?.doctor_plan_date_start || null,
    dept_code: src?.dept_code || '',
    dept_plan_date_start: src?.dept_plan_date_start || null,
    dept_plan_date_end: src?.dept_plan_date_end || null,
    keepalive_enabled: src?.keepalive_enabled ?? 1,
    keepalive_interval_min: src?.keepalive_interval_min ?? 40000,
    keepalive_interval_max: src?.keepalive_interval_max ?? 70000,
    keepalive_request_type: src?.keepalive_request_type || 'head',
    keepalive_business_endpoints: Array.isArray(src?.keepalive_business_endpoints) ? [...src.keepalive_business_endpoints] : [],
    direct_keepalive_enabled: src?.direct_keepalive_enabled ?? 0,
    heartbeat_timeout: src?.heartbeat_timeout ?? 300000,
    fingerprint_name: parseField(src?.fingerprint_config)?.name || 'android_app',
  })
  Object.assign(form.reuseChannel, { enabled: false, minInterval: 1000, reuseOnTimeout: false, reuseOnError: false, ...rc })
  Object.assign(form.lockCfg, { reservedChannels: 0, lockStartTime: '', firstLockDelayMs: 0, windowTime: 20000, minInterval: 250, directRequestOnNoChannel: false, submitSignStrategy: 'rotate', ...lk })
  lockMode.value = lk.lockStartTime ? 'scheduled' : 'immediate'
  Object.assign(form.channelCfg, { startTime: '', windowTime: 270000, attempts: 200, distribution: 'uniform', maxSuccessChannels: 0, ...cb })
  Object.assign(form.earlyStop, { enabled: true, algorithm: 'dynamic', multiplier: 15, fixedThreshold: 20000, ...(cb.earlyStop || {}) })
  Object.assign(form.autoClose, { enabled: true, maxSuccessChannels: 'auto', monitorInterval: 0, ...(cb.autoCloseExcess || {}) })
  form.target_hosts = Array.isArray(cb.targetHosts) && cb.targetHosts.length
    ? [...cb.targetHosts]
    : (Array.isArray(src?.target_hosts) ? [...src.target_hosts] : [])
  dialog.value = true
}

function copyTmpl(row) {
  openTmpl(row)
  editing.value = null
  form.name = `${row.name}（副本）`
}

async function saveTmpl() {
  if (!form.name) return ElMessage.warning('请输入模板名称')
  if (!isTimeString(form.check_start_time)) return ElMessage.error('查票开始时间格式不正确，应为 HH:MM:SS')
  if (!isTimeString(form.channelCfg.startTime)) return ElMessage.error('通道开始时间格式不正确，应为 HH:MM:SS')
  if (lockMode.value === 'scheduled' && !form.lockCfg.lockStartTime) return ElMessage.error('已选择指定时间，请填写锁号开始时间')
  if (lockMode.value === 'scheduled' && !isTimeString(form.lockCfg.lockStartTime)) return ElMessage.error('锁号开始时间格式不正确，应为 HH:MM:SS.mmm')
  if (form.autoClose.enabled && !isValidMaxChannels(form.autoClose.maxSuccessChannels))
    return ElMessage.error('最大通道数应为 "auto" 或正整数')
  if (form.keepalive_enabled) {
    if (!Number.isFinite(form.keepalive_interval_min) || !Number.isFinite(form.keepalive_interval_max)
        || form.keepalive_interval_min < 1000 || form.keepalive_interval_max < 1000)
      return ElMessage.error('心跳间隔范围应为 ≥1000 的整数（ms）')
    if (form.keepalive_interval_min > form.keepalive_interval_max)
      return ElMessage.error('心跳间隔下界不能大于上界')
    if (form.keepalive_request_type === 'systemConfig' && form.keepalive_business_endpoints.length === 0)
      return ElMessage.error('已选择"模拟业务"心跳类型，但未启用任何业务端点')
  }
  const payload = {
    name: form.name, description: form.description,
    check_start_time: form.check_start_time,
    check_window_time: form.check_window_time,
    check_min_interval: form.check_min_interval,
    check_distribution: form.check_distribution,
    check_stop_after_found_count: form.check_stop_after_found_count,
    check_reuse_channel: { ...form.reuseChannel },
    lock_config: { ...form.lockCfg, lockStartTime: lockMode.value === 'immediate' ? '' : form.lockCfg.lockStartTime },
    channel_build_overrides: {
      ...form.channelCfg,
      earlyStop: { ...form.earlyStop },
      autoCloseExcess: { ...form.autoClose },
      targetHosts: form.target_hosts.length ? form.target_hosts : null,
    },
    target_hosts: form.target_hosts.length ? form.target_hosts : null,
    check_mode: form.check_mode,
    doctor_source: form.doctor_source,
    doctor_select_mode: form.doctor_select_mode,
    doctor_codes: [...form.doctor_codes],
    doctor_plan_date_start: form.doctor_plan_date_start || null,
    dept_code: form.dept_code || null,
    dept_plan_date_start: form.dept_plan_date_start || null,
    dept_plan_date_end: form.dept_plan_date_end || null,
    keepalive_enabled: form.keepalive_enabled,
    keepalive_interval_min: form.keepalive_interval_min,
    keepalive_interval_max: form.keepalive_interval_max,
    keepalive_request_type: form.keepalive_request_type,
    keepalive_business_endpoints: [...form.keepalive_business_endpoints],
    direct_keepalive_enabled: form.direct_keepalive_enabled,
    heartbeat_timeout: form.heartbeat_timeout,
    fingerprint_config: { name: form.fingerprint_name },
  }
  if (editing.value?.id) await updateProxyTemplate(editing.value.id, payload)
  else await createProxyTemplate(payload)
  dialog.value = false; await loadAll(); ElMessage.success('保存成功')
}

async function delTmpl(row) {
  await ElMessageBox.confirm(`确定删除模板 "${row.name}"？`)
  await deleteProxyTemplate(row.id); await loadAll()
}

onMounted(loadAll)
</script>

<style scoped>
.tmpl-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.tmpl-hint { margin-left: 8px; color: #909399; font-size: 12px; }

.tmpl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 14px;
  align-items: start;
}

.tmpl-card {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tmpl-card-header {
  padding: 12px 16px 10px;
  border-bottom: 1px solid #f0f2f5;
}
.tmpl-card-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  display: flex;
  align-items: center;
}
.tmpl-card-desc {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.tmpl-card-body {
  display: flex;
  flex: 1;
  padding: 10px 4px;
}

.tmpl-section {
  flex: 1;
  min-width: 0;
  padding: 0 12px;
  border-right: 1px solid #f0f2f5;
}
.tmpl-section:first-child { padding-left: 12px; }
.tmpl-section:last-child  { border-right: none; }

.tmpl-section-title {
  font-size: 11px;
  font-weight: 600;
  color: #b0b3bb;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.tmpl-kv {
  display: grid;
  grid-template-columns: auto 1fr;
  row-gap: 3px;
  column-gap: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.tmpl-kv .k {
  color: #909399;
  white-space: nowrap;
}
.tmpl-kv .v {
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tmpl-kv .v.mono { font-family: monospace; }

.tmpl-card-footer {
  padding: 8px 12px;
  border-top: 1px solid #f0f2f5;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
</style>
