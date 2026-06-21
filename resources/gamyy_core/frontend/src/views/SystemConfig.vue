<template>
  <MainLayout>
    <el-card shadow="never" style="width:100%" v-loading="loading">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>系统配置</span>
          <el-button type="primary" :loading="saving" @click="handleSave">保存系统配置</el-button>
        </div>
      </template>

      <el-form :model="form" label-width="160px">

        <!-- ── 目标主机列表 ── -->
        <el-divider content-position="left">目标主机 (connectionPool.targetHosts)</el-divider>
        <el-form-item label=" " label-width="160px">
          <div style="width:100%">
            <el-table :data="form.target_hosts" size="small" border style="margin-bottom:8px">
              <el-table-column label="Host" min-width="180">
                <template #default="{ row }">
                  <el-input v-model="row.host" size="small" placeholder="IP 或域名" />
                </template>
              </el-table-column>
              <el-table-column label="Port" width="90">
                <template #default="{ row }">
                  <el-input-number v-model="row.port" size="small" :min="1" :max="65535" :controls="false" style="width:75px" />
                </template>
              </el-table-column>
              <el-table-column label="SNI（可选）" min-width="180">
                <template #default="{ row }">
                  <el-input v-model="row.sni" size="small" placeholder="留空则不设置" />
                </template>
              </el-table-column>
              <el-table-column label="" width="60" align="center">
                <template #default="{ $index }">
                  <el-button link type="danger" size="small" @click="form.target_hosts.splice($index, 1)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-button size="small" @click="form.target_hosts.push({ host: '', port: 443, sni: '' })">+ 添加主机</el-button>
          </div>
        </el-form-item>

        <!-- ── 超时配置 ── -->
        <el-divider content-position="left">超时配置</el-divider>
        <el-form-item label="连接超时 (ms)">
          <el-input-number v-model="form.connect_timeout" :min="1000" :step="1000" />
        </el-form-item>
        <el-form-item label="请求超时 (ms)">
          <el-input-number v-model="form.request_timeout" :min="1000" :step="1000" />
        </el-form-item>
        <!-- 心跳超时 / 心跳保活(keepAlive) 已下沉到代理层：见 代理模板 与 账号-代理配置 弹窗 -->

        <!-- ── 账号代理默认值 ── -->
        <el-divider content-position="left">账号代理</el-divider>
        <el-form-item label="默认代理数上限">
          <el-input-number v-model="form.default_proxy_max_count" :min="1" :max="200" :step="1" controls-position="right" />
          <span style="margin-left:10px;color:#909399;font-size:12px">创建账号时及自动分配时的默认上限，单账号可单独覆盖</span>
        </el-form-item>

        <!-- ── 云端代理 ── -->
        <el-divider content-position="left">云端代理</el-divider>
        <el-form-item label="Agent 不可达时">
          <el-radio-group v-model="form.cloud_unreachable_action">
            <el-radio value="fallback">降级为本地运行</el-radio>
            <el-radio value="discard">直接丢弃该代理</el-radio>
          </el-radio-group>
          <div style="margin-top:4px;color:#909399;font-size:12px">任务启动时若云端 Agent 探活失败的处理方式</div>
        </el-form-item>
        <el-form-item label="管理通信走代理">
          <el-switch v-model="form.cloud_dispatch_via_proxy" :active-value="1" :inactive-value="0" />
          <div style="margin-top:4px;color:#909399;font-size:12px;line-height:1.6">
            开启后,本地→云端 Agent 的 /run / /status / /stop 等请求经该账号的<strong>操作代理 (ops_proxy)</strong>中转,而非本地公网直连。<br />
            注意:开启后该账号必须已分配 ops_proxy 才能启动云端任务;走代理后超时与 backoff 自动加大(详见 ARCHITECTURE.md)。
          </div>
        </el-form-item>

        <!-- ── 客户端身份基线 ── -->
        <el-divider content-position="left">客户端身份基线</el-divider>
        <div style="margin:0 0 12px 160px;color:#909399;font-size:12px;line-height:1.6">
          <div>这里维护的是<strong>"最新版本基线"</strong>和 <strong>UA 池</strong>，不是"全体账号当前生效值"。</div>
          <div>保存后只影响：① <strong>新建账号</strong>（从 UA 池随机抽 1 条 + 当前 CLIENT_VERSION/REFERER 写入该账号）；② <strong>下次登录的账号</strong>（登录成功后将该账号的 CLIENT_VERSION/REFERER 刷为最新基线，UA 不动）。已登录账号在再次登录前不会被改动。</div>
        </div>

        <el-tabs type="border-card" style="margin-bottom:16px">
          <!-- App iOS -->
          <el-tab-pane label="App iOS">
            <el-form-item label="最新版本">
              <el-input v-model="form.app_client_config.CLIENT_VERSION" placeholder="如 4.3.2" style="max-width:300px" />
              <span style="margin-left:10px;color:#909399;font-size:12px">登录成功时刷到账号的 client_version 字段</span>
            </el-form-item>
            <el-form-item label="固定参数">
              <span style="color:#606266;font-size:13px">PLATFORM</span>
              <el-input v-model="form.app_client_config.PLATFORM" placeholder="如 2" style="max-width:80px;margin:0 12px 0 6px" />
              <span style="color:#606266;font-size:13px">FROM</span>
              <el-input v-model="form.app_client_config.FROM" placeholder="如 0" style="max-width:80px;margin-left:6px" />
              <span style="margin-left:10px;color:#909399;font-size:12px">极少修改</span>
            </el-form-item>
            <el-form-item label="UA 池">
              <UaPoolEditor v-model="form.app_ua_pool" />
            </el-form-item>
          </el-tab-pane>

          <!-- App Android -->
          <el-tab-pane label="App Android">
            <el-form-item label="最新版本">
              <el-input v-model="form.android_client_config.CLIENT_VERSION" placeholder="如 4.3.0" style="max-width:300px" />
              <span style="margin-left:10px;color:#909399;font-size:12px">登录成功时刷到账号的 client_version 字段</span>
            </el-form-item>
            <el-form-item label="固定参数">
              <span style="color:#606266;font-size:13px">PLATFORM</span>
              <el-input v-model="form.android_client_config.PLATFORM" placeholder="如 1" style="max-width:80px;margin:0 12px 0 6px" />
              <span style="color:#606266;font-size:13px">FROM</span>
              <el-input v-model="form.android_client_config.FROM" placeholder="如 0" style="max-width:80px;margin-left:6px" />
              <span style="margin-left:10px;color:#909399;font-size:12px">极少修改</span>
            </el-form-item>
            <el-form-item label="UA 池">
              <UaPoolEditor v-model="form.android_ua_pool" />
            </el-form-item>
          </el-tab-pane>

          <!-- 微信端 -->
          <el-tab-pane label="微信端">
            <el-form-item label="最新版本">
              <el-input v-model="form.wechat_client_config.CLIENT_VERSION" placeholder="如 6.5.14" style="max-width:300px" />
              <span style="margin-left:10px;color:#909399;font-size:12px">登录成功时与 REFERER 一起刷到账号</span>
            </el-form-item>
            <el-form-item label="REFERER（同版本）">
              <el-input v-model="form.wechat_client_config.REFERER" placeholder="如 https://servicewechat.com/wx.../172/page-frame.html" />
              <div style="color:#909399;font-size:12px;margin-top:4px">和"最新版本"配对维护：升版本号时记得把这里的路径段（如 /172/）一起改。两者会在登录刷新时一起写入账号。</div>
            </el-form-item>
            <el-form-item label="固定参数">
              <span style="color:#606266;font-size:13px">ORIGIN</span>
              <el-input-number v-model="form.wechat_client_config.ORIGIN" :min="0" :controls="false" style="width:80px;margin:0 12px 0 6px" />
              <span style="color:#606266;font-size:13px">FROM</span>
              <el-input v-model="form.wechat_client_config.FROM" placeholder="如 8" style="max-width:80px;margin-left:6px" />
              <span style="margin-left:10px;color:#909399;font-size:12px">极少修改</span>
            </el-form-item>
            <el-form-item label="UA 池">
              <UaPoolEditor v-model="form.wechat_ua_pool" />
            </el-form-item>
          </el-tab-pane>
        </el-tabs>

        <!-- ── 代理分类器 ── -->
        <el-divider content-position="left">代理分类器 (proxyClassifier)</el-divider>
        <el-form-item label="启用分类器">
          <el-switch v-model="form.proxy_classifier.enabled" />
        </el-form-item>
        <template v-if="form.proxy_classifier.enabled">
          <el-form-item label="触发方式">
            <el-radio-group v-model="form.proxy_classifier.triggerMode">
              <el-radio value="timer">仅定时轮询</el-radio>
              <el-radio value="event">仅早停事件</el-radio>
              <el-radio value="both">两者同时（推荐）</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="轮询间隔 (ms)" v-if="form.proxy_classifier.triggerMode !== 'event'">
            <el-input-number v-model="form.proxy_classifier.monitorInterval" :min="1000" :step="1000" />
          </el-form-item>
          <el-form-item label="最少代理数">
            <el-input-number v-model="form.proxy_classifier.minProxies" :min="1" />
          </el-form-item>
          <el-form-item label="阈值算法">
            <el-radio-group v-model="form.proxy_classifier.thresholdMethod">
              <el-radio value="stddev">均值+标准差</el-radio>
              <el-radio value="iqr">四分位距上界</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="最小有效间隔 (ms)">
            <el-input-number v-model="form.proxy_classifier.minGapMs" :min="0" :step="1000" />
          </el-form-item>
        </template>

      </el-form>
    </el-card>
  </MainLayout>
</template>

<script setup>
import { ref, reactive, h, onMounted } from 'vue'
import { ElMessage, ElInput, ElButton, ElEmpty } from 'element-plus'
import MainLayout from '@/layout/MainLayout.vue'
import { getSystemConfig, saveSystemConfig } from '@/api'

// 内联子组件：UA 池编辑器。v-model 绑定一个字符串数组；每行一条 UA。
const UaPoolEditor = {
  props: { modelValue: { type: Array, default: () => [] } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const update = (i, v) => {
      const next = props.modelValue.slice()
      next[i] = v
      emit('update:modelValue', next)
    }
    const remove = (i) => {
      const next = props.modelValue.slice()
      next.splice(i, 1)
      emit('update:modelValue', next)
    }
    const add = () => emit('update:modelValue', [...(props.modelValue || []), ''])
    return () => h('div', { style: 'width:100%' }, [
      props.modelValue.length === 0
        ? h(ElEmpty, { description: '池为空，请添加 UA', imageSize: 60 })
        : props.modelValue.map((ua, i) =>
            h('div', { key: i, style: 'display:flex;gap:8px;align-items:flex-start;margin-bottom:6px' }, [
              h('div', { style: 'width:36px;line-height:32px;color:#909399;font-size:12px;text-align:center' }, '#' + (i + 1)),
              h(ElInput, {
                modelValue: ua, type: 'textarea', rows: 2, autosize: { minRows: 2, maxRows: 4 },
                'onUpdate:modelValue': (v) => update(i, v),
                style: 'flex:1', placeholder: '一条完整 UA',
              }),
              h(ElButton, { link: true, type: 'danger', size: 'small', onClick: () => remove(i) }, () => '删除'),
            ])
          ),
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:6px' }, [
        h('span', { style: 'color:#909399;font-size:12px' }, `共 ${props.modelValue.length} 条`),
        h(ElButton, { size: 'small', onClick: add }, () => '+ 添加 UA'),
      ]),
    ])
  },
}

const loading = ref(false), saving = ref(false)

const defaultClassifier = () => ({
  enabled: false,
  triggerMode: 'both',
  monitorInterval: 20000,
  minProxies: 5,
  thresholdMethod: 'stddev',
  minGapMs: 15000,
})

const form = reactive({
  target_hosts: [],
  connect_timeout: 300000,
  request_timeout: 300000,
  cloud_unreachable_action: 'fallback',
  cloud_dispatch_via_proxy: 1,
  proxy_classifier: defaultClassifier(),
  default_proxy_max_count: 10,
  // 客户端身份基线：仅版本号 + 固定参数（USER_AGENT 已迁出到 *_ua_pool）
  app_client_config:     { CLIENT_VERSION: '', PLATFORM: '', FROM: '' },
  android_client_config: { CLIENT_VERSION: '', PLATFORM: '', FROM: '' },
  wechat_client_config:  { CLIENT_VERSION: '', ORIGIN: 1, FROM: '', REFERER: '' },
  // UA 池（按端独立）
  app_ua_pool: [],
  android_ua_pool: [],
  wechat_ua_pool: [],
})

async function load() {
  loading.value = true
  try {
    const res = await getSystemConfig()
    const d = res.data || {}
    Object.assign(form, {
      target_hosts:           Array.isArray(d.target_hosts) ? d.target_hosts : [],
      connect_timeout:        d.connect_timeout        ?? 300000,
      request_timeout:        d.request_timeout        ?? 300000,
      cloud_unreachable_action: d.cloud_unreachable_action ?? 'fallback',
      cloud_dispatch_via_proxy: d.cloud_dispatch_via_proxy ?? 1,
      proxy_classifier:       Object.keys(d.proxy_classifier || {}).length
                                ? d.proxy_classifier
                                : defaultClassifier(),
      default_proxy_max_count: d.default_proxy_max_count ?? 10,
      app_client_config:     d.app_client_config     || { CLIENT_VERSION: '', PLATFORM: '', FROM: '' },
      android_client_config: d.android_client_config || { CLIENT_VERSION: '', PLATFORM: '', FROM: '' },
      wechat_client_config:  d.wechat_client_config  || { CLIENT_VERSION: '', ORIGIN: 1, FROM: '', REFERER: '' },
      app_ua_pool:     Array.isArray(d.app_ua_pool)     ? d.app_ua_pool     : [],
      android_ua_pool: Array.isArray(d.android_ua_pool) ? d.android_ua_pool : [],
      wechat_ua_pool:  Array.isArray(d.wechat_ua_pool)  ? d.wechat_ua_pool  : [],
    })
  } finally { loading.value = false }
}

function validateUaPool(pool, label) {
  if (!Array.isArray(pool) || pool.length === 0) return `${label} 不能为空`
  for (let i = 0; i < pool.length; i++) {
    if (!pool[i] || !pool[i].trim()) return `${label} 第 ${i + 1} 条不能为空`
  }
  return null
}

async function handleSave() {
  for (let i = 0; i < form.target_hosts.length; i++) {
    const h = form.target_hosts[i]
    if (!h.host || !h.host.trim()) return ElMessage.error(`目标主机第 ${i + 1} 行 host 不能为空`)
  }
  for (const [pool, label] of [
    [form.app_ua_pool,     'App iOS UA 池'],
    [form.android_ua_pool, 'App Android UA 池'],
    [form.wechat_ua_pool,  '微信端 UA 池'],
  ]) {
    const msg = validateUaPool(pool, label)
    if (msg) return ElMessage.error(msg)
  }
  saving.value = true
  try {
    const payload = {
      target_hosts:           form.target_hosts,
      connect_timeout:        form.connect_timeout,
      request_timeout:        form.request_timeout,
      cloud_unreachable_action: form.cloud_unreachable_action,
      cloud_dispatch_via_proxy: form.cloud_dispatch_via_proxy,
      proxy_classifier:        form.proxy_classifier,
      default_proxy_max_count: form.default_proxy_max_count,
      app_client_config:       form.app_client_config,
      android_client_config:   form.android_client_config,
      wechat_client_config:    form.wechat_client_config,
      app_ua_pool:             form.app_ua_pool,
      android_ua_pool:         form.android_ua_pool,
      wechat_ua_pool:          form.wechat_ua_pool,
    }
    await saveSystemConfig(payload)
    ElMessage.success('配置已保存（仅作用于新建账号与下次登录账号）')
  } finally { saving.value = false }
}

onMounted(() => { load() })
</script>
