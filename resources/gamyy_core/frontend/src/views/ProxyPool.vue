<template>
  <MainLayout>
    <div class="proxy-pool-root">
      <el-tabs v-model="activeTab" type="border-card" class="main-tabs" @tab-click="onTabClick">

        <!-- ════════════════════════ 基本代理 Tab ════════════════════════ -->
        <el-tab-pane label="基本代理" name="proxy">
          <div class="tab-content">

            <div class="toolbar">
              <div class="toolbar-left">
                <template v-if="proxySelected.length > 0">
                  <el-button :loading="batchTesting" @click="startBatchTestJob">批量测试</el-button>
                  <el-button :loading="batchAfdRunning" @click="startBatchAfdJob">批量AFD</el-button>
                  <el-button type="primary" plain @click="openAssignDialog">分配账号</el-button>
                  <el-button @click="proxyBatchOp('enable')">任务启用</el-button>
                  <el-button @click="proxyBatchOp('disable')">任务禁用</el-button>
                  <el-button @click="proxyBatchOp('ops_enable')">操作启用</el-button>
                  <el-button @click="proxyBatchOp('ops_disable')">操作禁用</el-button>
                  <el-button type="danger" @click="proxyBatchOp('delete')">删除</el-button>
                </template>
              </div>
              <div class="toolbar-right">
                <el-button :loading="directAdding" @click="doAddDirect">本机直连</el-button>
                <el-button :icon="Upload" @click="batchImportDialog = true">批量导入</el-button>
                <el-button :icon="MagicStick" :loading="autoAssigning" @click="doAutoAssignAll">自动分配</el-button>
                <el-divider direction="vertical" />
                <span>总计 <b>{{ proxyStats.total || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>可用 <b style="color:#67c23a">{{ proxyStats.working_count || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>已分配 <b style="color:#409eff">{{ proxyStats.assigned_count || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>启用 <b>{{ proxyStats.enabled_count || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>已选 <b>{{ proxySelected.length }}</b></span>
              </div>
            </div>

            <el-alert v-if="activeProxyJob" :closable="false" style="margin-bottom:8px">
              <template #default>
                {{ activeProxyJob.type === 'test' ? '批量测试' : '批量AFD查询' }} 进行中：
                {{ activeProxyJob.done }}/{{ activeProxyJob.total }}（失败 {{ activeProxyJob.errors }}）
                <el-button v-if="activeProxyJob.status === 'done'" size="small" text @click="activeProxyJob = null; loadProxyAll()">完成，刷新</el-button>
              </template>
            </el-alert>

            <el-table v-loading="proxyLoading" :data="proxyRows" size="small" border @selection-change="proxySelected = $event" class="data-table" :row-class-name="({ row }) => row.is_risk_flagged ? 'row-risk' : ''">
              <el-table-column type="selection" width="42" fixed />
              <el-table-column label="代理地址" width="180" show-overflow-tooltip>
                <template #default="{ row }">
                  <template v-if="row.proxy_type === 'direct'">
                    <el-tag size="small" type="success" style="margin-right:4px;vertical-align:middle">直连</el-tag>
                    <span class="mono">{{ row.real_ip || '—' }}</span>
                  </template>
                  <span v-else class="mono">{{ row.host }}:{{ row.port }}</span>
                </template>
              </el-table-column>
              <el-table-column label="真实IP" width="140">
                <template #default="{ row }"><span class="mono">{{ row.real_ip || '—' }}</span></template>
              </el-table-column>
              <el-table-column label="平台" width="90" align="center">
                <template #default="{ row }">
                  <span v-if="row.platform" class="mono" style="font-size:12px">{{ row.platform }}</span>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="可用" width="68" align="center">
                <template #default="{ row }">
                  <span class="dot" :class="row.is_working ? 'dot-on' : 'dot-off'" />
                </template>
              </el-table-column>
              <el-table-column label="响应(ms)" width="85" align="right">
                <template #default="{ row }">
                  <span :style="row.response_time ? (row.response_time < 3000 ? 'color:#67c23a' : 'color:#e6a23c') : ''">
                    {{ row.response_time != null ? Math.round(row.response_time) : '—' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="风险等级" width="90" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.ip_risk_level" :type="riskType(row.ip_risk_level)" size="small">{{ row.ip_risk_level }}</el-tag>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="运营商" prop="ip_isp"      width="90"  show-overflow-tooltip />
              <el-table-column label="归属地" prop="ip_location" min-width="130" show-overflow-tooltip />
              <el-table-column label="已分配账号" min-width="130">
                <template #default="{ row }">
                  <span v-if="row.account_mobile" class="mono" style="color:#409eff">{{ row.account_mobile }}</span>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="风控" width="58" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.is_risk_flagged" type="danger" size="small">风控</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="100" fixed="right">
                <template #default="{ row }">
                  <el-button v-if="row.proxy_type !== 'direct'" link size="small" @click="openEditProxy(row)">编辑</el-button>
                  <el-button link size="small" type="danger" @click="doDeleteProxy(row)">删除</el-button>
                </template>
              </el-table-column>
              <el-table-column label="任务" width="60" align="center">
                <template #default="{ row }">
                  <el-switch :model-value="!!row.enabled" size="small" @change="(v) => toggleProxyEnabled(row, v)" />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="60" align="center">
                <template #default="{ row }">
                  <el-switch :model-value="!!row.ops_enabled" size="small" @change="(v) => toggleProxyOpsEnabled(row, v)" />
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <!-- ════════════════════════ SSH隧道代理 Tab ════════════════════════ -->
        <el-tab-pane label="SSH隧道代理" name="ssh">
          <div class="tab-content">

            <div class="toolbar">
              <div class="toolbar-left">
                <template v-if="sshSelected.length > 0">
                  <el-button :loading="sshBatchTesting" @click="startSshBatchTestJob">批量测试</el-button>
                  <el-button :loading="sshBatchAfdRunning" @click="startSshBatchAfdJob">批量AFD</el-button>
                  <el-button :loading="sshAgentChecking" @click="doBatchCheckAgents">批量检测Agent</el-button>
                  <el-button type="primary" plain @click="openSshAssignDialog">分配账号</el-button>
                  <el-button @click="sshBatchOp('enable')">任务启用</el-button>
                  <el-button @click="sshBatchOp('disable')">任务禁用</el-button>
                  <el-button @click="sshBatchOp('ops_enable')">操作启用</el-button>
                  <el-button @click="sshBatchOp('ops_disable')">操作禁用</el-button>
                  <el-button type="danger" @click="sshBatchOp('delete')">删除</el-button>
                </template>
              </div>
              <div class="toolbar-right">
                <el-select v-model="sshFilterRisk" size="small" placeholder="全部" clearable style="width:80px">
                  <el-option label="风控" value="1" />
                  <el-option label="正常" value="0" />
                </el-select>
                <el-divider direction="vertical" />
                <el-button :icon="Connection" @click="sshSyncDialog = true">同步DB</el-button>
                <el-button :icon="Upload" @click="sshBatchImportDialog = true">批量导入</el-button>
                <el-button :icon="MagicStick" :loading="sshAutoAssigning" @click="doSshAutoAssignAll">自动分配</el-button>
                <el-divider direction="vertical" />
                <span>总计 <b>{{ sshStats.total || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>可用 <b style="color:#67c23a">{{ sshStats.working_count || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>已分配 <b style="color:#409eff">{{ sshStats.assigned_count || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>启用 <b>{{ sshStats.enabled_count || 0 }}</b></span>
                <el-divider direction="vertical" />
                <span>已选 <b>{{ sshSelected.length }}</b></span>
              </div>
            </div>

            <el-alert v-if="activeSshJob" :closable="false" style="margin-bottom:8px">
              <template #default>
                {{ activeSshJob.type === 'test' ? '批量测试' : '批量AFD查询' }} 进行中：
                {{ activeSshJob.done }}/{{ activeSshJob.total }}（失败 {{ activeSshJob.errors }}）
                <el-button v-if="activeSshJob.status === 'done'" size="small" text @click="activeSshJob = null; loadSshAll()">完成，刷新</el-button>
              </template>
            </el-alert>

            <el-alert v-if="sshAgentResults" :closable="true" @close="sshAgentResults = null"
              :type="sshAgentResults.every(r => r.ok) ? 'success' : (sshAgentResults.some(r => r.ok) ? 'warning' : 'error')"
              style="margin-bottom:8px">
              <template #default>
                <span>Agent 检测完成：
                  <b style="color:#67c23a">{{ sshAgentResults.filter(r=>r.ok).length }} 在线</b> /
                  <b style="color:#f56c6c">{{ sshAgentResults.filter(r=>!r.ok).length }} 离线</b>
                  （共 {{ sshAgentResults.length }} 个）
                </span>
                <div style="margin-top:6px;font-size:11px;font-family:monospace;line-height:1.8">
                  <span v-for="r in sshAgentResults" :key="r.id" style="display:inline-block;margin-right:12px">
                    <span :style="{ color: r.ok ? '#67c23a' : '#f56c6c' }">{{ r.ok ? '✅' : '❌' }}</span>
                    {{ r.cloud_agent_url }}
                    <span v-if="r.ok" style="color:#909399">（{{ r.latencyMs }}ms）</span>
                  </span>
                </div>
              </template>
            </el-alert>

            <el-table v-loading="sshLoading" :data="filteredSshRows" size="small" border @selection-change="sshSelected = $event" class="data-table" :row-class-name="({ row }) => row.is_risk_flagged ? 'row-risk' : ''">
              <el-table-column type="selection" width="42" fixed />
              <el-table-column label="本地端口" width="160" show-overflow-tooltip>
                <template #default="{ row }">
                  <el-tag v-if="!row.port" type="info" size="small">仅云端</el-tag>
                  <span v-else class="mono">127.0.0.1:{{ row.port }}</span>
                </template>
              </el-table-column>
              <el-table-column label="云服务器IP" width="150">
                <template #default="{ row }"><span class="mono">{{ row.real_ip || '—' }}</span></template>
              </el-table-column>
              <el-table-column label="分组" width="70" align="center">
                <template #default="{ row }">
                  <span v-if="row.group_name" style="font-size:12px">{{ row.group_name }}</span>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="可用" width="68" align="center">
                <template #default="{ row }">
                  <span class="dot" :class="row.is_working ? 'dot-on' : 'dot-off'" />
                </template>
              </el-table-column>
              <el-table-column label="响应(ms)" width="85" align="right">
                <template #default="{ row }">
                  <span :style="row.response_time ? (row.response_time < 3000 ? 'color:#67c23a' : 'color:#e6a23c') : ''">
                    {{ row.response_time != null ? Math.round(row.response_time) : '—' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="风险等级" width="90" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.ip_risk_level" :type="riskType(row.ip_risk_level)" size="small">{{ row.ip_risk_level }}</el-tag>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="运营商" prop="ip_isp"      width="90"  show-overflow-tooltip />
              <el-table-column label="归属地" prop="ip_location" min-width="130" show-overflow-tooltip />
              <el-table-column label="已分配账号" min-width="130">
                <template #default="{ row }">
                  <span v-if="row.account_mobile" class="mono" style="color:#409eff">{{ row.account_mobile }}</span>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="云端Agent" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">
                  <span v-if="row.cloud_agent_url" class="mono" style="color:#67c23a;font-size:11px">{{ row.cloud_agent_url }}</span>
                  <span v-else style="color:#c0c4cc">—</span>
                </template>
              </el-table-column>
              <el-table-column label="风控" width="58" align="center">
                <template #default="{ row }">
                  <el-tag v-if="row.is_risk_flagged" type="danger" size="small">风控</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right">
                <template #default="{ row }">
                  <el-button link size="small" @click="openSshEdit(row)">编辑</el-button>
                  <el-button link size="small" type="danger" @click="doDeleteSsh(row)">删除</el-button>
                </template>
              </el-table-column>
              <el-table-column label="任务" width="60" align="center">
                <template #default="{ row }">
                  <el-switch :model-value="!!row.enabled" size="small" @change="(v) => toggleSshEnabled(row, v)" />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="60" align="center">
                <template #default="{ row }">
                  <el-switch :model-value="!!row.ops_enabled" size="small" @change="(v) => toggleSshOpsEnabled(row, v)" />
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

      </el-tabs>
    </div>

    <!-- ══════════════ 基本代理 对话框 ══════════════ -->

    <el-dialog v-model="editProxyDialog" title="编辑代理" width="480px">
      <el-form :model="editProxyForm" label-width="90px" size="small">
        <el-form-item label="IP 地址" required>
          <el-input v-model="editProxyForm.host" placeholder="e.g. 1.2.3.4" :disabled="!!editProxyRow" />
        </el-form-item>
        <el-form-item label="端口" required>
          <el-input-number v-model="editProxyForm.port" :min="1" :max="65535" :controls="false" :disabled="!!editProxyRow" style="width:120px" />
        </el-form-item>
        <el-form-item label="用户名"><el-input v-model="editProxyForm.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="editProxyForm.password" show-password /></el-form-item>
        <el-form-item label="分组"><el-input v-model="editProxyForm.group_name" /></el-form-item>
        <el-form-item label="平台"><el-input v-model="editProxyForm.platform" /></el-form-item>
        <el-form-item label="过期时间"><el-input v-model="editProxyForm.expire_time" placeholder="YYYY-MM-DD HH:MM:SS" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editProxyDialog = false">取消</el-button>
        <el-button type="primary" :loading="editProxySaving" @click="saveProxy">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchImportDialog" title="批量导入代理" width="520px">
      <p style="color:#909399;font-size:12px;margin:0 0 10px">
        每行一条：<code>ip:port:user:pass</code> 或 <code>ip|port|user|pass|expire</code>
      </p>
      <el-input v-model="importText" type="textarea" :rows="10"
        placeholder="1.2.3.4:8080:user:pass&#10;5.6.7.8:3128"
        style="font-family:monospace;font-size:12px" />
      <div style="display:flex;gap:8px;margin-top:10px">
        <el-input v-model="importGroup"    placeholder="分组（可选）" style="flex:1" size="small" />
        <el-input v-model="importPlatform" placeholder="平台（可选）" style="flex:1" size="small" />
      </div>
      <template #footer>
        <el-button @click="batchImportDialog = false">取消</el-button>
        <el-button type="primary" :loading="importSaving" @click="doBatchImport">导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assignDialog" title="分配账号" width="360px">
      <p style="color:#909399;font-size:12px;margin:0 0 12px">
        将选中的 <b>{{ proxySelected.length }}</b> 条代理分配给指定账号
      </p>
      <el-select v-model="assignAccountId" placeholder="选择目标账号" style="width:100%" filterable>
        <el-option v-for="a in enabledAccounts" :key="a.id" :label="`${a.mobile}（上限 ${a.proxy_max_count} 条）`" :value="a.id" />
      </el-select>
      <template #footer>
        <el-button @click="assignDialog = false">取消</el-button>
        <el-button type="primary" :loading="assignSaving" @click="doAssign">确认分配</el-button>
      </template>
    </el-dialog>

    <!-- ══════════════ SSH隧道代理 对话框 ══════════════ -->

    <el-dialog v-model="sshSyncDialog" title="从 cloud_proxy_pool 同步" width="540px">
      <p style="color:#909399;font-size:12px;margin:0 0 10px">
        输入 <code>proxy_manager.db</code> 的完整路径，仅同步 <code>is_active = 1</code> 的活跃代理。<br>
        同步结果以 <code>(云服务器IP, 本地端口)</code> 为唯一键做 upsert，不会产生重复。
      </p>
      <el-input v-model="sshSyncPath" placeholder="例：E:\gamyy_proxy\cloud_proxy_pool\proxy_manager.db" />
      <template #footer>
        <el-button @click="sshSyncDialog = false">取消</el-button>
        <el-button type="primary" :loading="sshSyncing" @click="doSshSync">开始同步</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="sshBatchImportDialog" title="批量导入 SSH 代理" width="560px">
      <p style="color:#909399;font-size:12px;margin:0 0 10px;line-height:1.7">
        每行一条，允许混合两种格式：<br>
        · <code>IP</code> — 仅云端运行（任务下发到 <code>http://&lt;ip&gt;:7070</code>，无本地 SOCKS5 端口）<br>
        · <code>IP:port</code> 或 <code>IP|port</code> — 同时具备本地 SOCKS5 转发端口<br>
        以 <code>real_ip</code> 为唯一键，已存在则覆盖本地端口与云端 Agent URL。
      </p>
      <el-input v-model="sshBatchImportText" type="textarea" :rows="10"
        placeholder="1.2.3.4&#10;5.6.7.8:5002&#10;9.10.11.12|5003"
        style="font-family:monospace;font-size:12px" />
      <div style="display:flex;gap:8px;margin-top:10px">
        <el-input v-model="sshBatchImportGroup"    placeholder="分组（可选）" style="flex:1" size="small" />
        <el-input v-model="sshBatchImportPlatform" placeholder="平台（可选）" style="flex:1" size="small" />
      </div>
      <template #footer>
        <el-button @click="sshBatchImportDialog = false">取消</el-button>
        <el-button type="primary" :loading="sshBatchImporting" @click="doSshBatchImport">导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="sshAssignDialog" title="分配账号" width="360px">
      <p style="color:#909399;font-size:12px;margin:0 0 12px">
        将选中的 <b>{{ sshSelected.length }}</b> 条 SSH 代理分配给指定账号
      </p>
      <el-select v-model="sshAssignAccountId" placeholder="选择目标账号" style="width:100%" filterable>
        <el-option v-for="a in enabledAccounts" :key="a.id" :label="`${a.mobile}（上限 ${a.proxy_max_count} 条）`" :value="a.id" />
      </el-select>
      <template #footer>
        <el-button @click="sshAssignDialog = false">取消</el-button>
        <el-button type="primary" :loading="sshAssignSaving" @click="doSshAssign">确认分配</el-button>
      </template>
    </el-dialog>

    <!-- ══════════════ SSH 代理编辑对话框 ══════════════ -->

    <el-dialog v-model="sshEditDialog" title="编辑 SSH 代理" width="500px">
      <el-form label-width="110px" size="small">
        <el-form-item label="本地地址">
          <el-input v-if="sshEditRow?.port" :value="`127.0.0.1:${sshEditRow.port}`" disabled />
          <el-input v-else value="仅云端运行（无本地端口）" disabled />
        </el-form-item>
        <el-form-item label="云服务器IP">
          <el-input :value="sshEditRow?.real_ip || '—'" disabled />
        </el-form-item>
        <el-form-item label="云端 Agent URL">
          <el-input v-model="sshEditForm.cloud_agent_url" placeholder="http://1.2.3.4:7070" clearable />
        </el-form-item>
      </el-form>
      <div v-if="sshHealthResult" :style="{ marginTop: '8px', color: sshHealthResult.ok ? '#67c23a' : '#f56c6c', fontSize: '12px' }">
        {{ sshHealthResult.msg }}
      </div>
      <template #footer>
        <el-button @click="sshEditDialog = false">取消</el-button>
        <el-button :loading="sshHealthChecking" @click="doSshHealthCheck">检测连接</el-button>
        <el-button type="primary" :loading="sshEditSaving" @click="saveSshEdit">保存</el-button>
      </template>
    </el-dialog>

  </MainLayout>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { Upload, MagicStick, Connection } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import MainLayout from '@/layout/MainLayout.vue'
import {
  getProxyPool, getProxyPoolStats, getSshProxyStats, sshSyncFromDb, sshBatchImport,
  updateProxyEntry, deleteProxyEntry,
  batchImportProxies, batchOpsProxy,
  startBatchTest, startBatchAfd, getProxyJob,
  batchAssign, getAccounts, autoAssignAll, addDirectProxy,
  setProxyCloudAgent, checkProxyCloudAgent, batchCheckCloudAgents,
  autoFillAgentUrls,
} from '@/api'
import { isDatetime } from '@/utils/validate'

// ─────────────────────────────────────────────────────────
// 共用
// ─────────────────────────────────────────────────────────
const activeTab       = ref('proxy')
const enabledAccounts = ref([])

async function loadEnabledAccounts() {
  const res = await getAccounts({ enabled: '1' })
  enabledAccounts.value = res.data || []
}

function onTabClick(tab) {
  if (tab.paneName === 'ssh' && sshRows.value.length === 0) loadSshAll()
}

function riskType(level) {
  if (!level) return 'info'
  if (level.includes('无')) return 'success'
  if (level.includes('低')) return ''
  if (level.includes('中')) return 'warning'
  if (level.includes('高')) return 'danger'
  return 'info'
}

// ─────────────────────────────────────────────────────────
// 基本代理
// ─────────────────────────────────────────────────────────
const proxyLoading  = ref(false)
const proxyRows     = ref([])
const proxySelected = ref([])
const proxyStats    = reactive({})
const activeProxyJob  = ref(null)
const batchTesting    = ref(false)
const batchAfdRunning = ref(false)
let   proxyJobTimer   = null

const editProxyDialog  = ref(false)
const editProxyRow     = ref(null)
const editProxySaving  = ref(false)
const editProxyForm    = reactive({ host:'', port: null, username:'', password:'', group_name:'', platform:'', expire_time:'' })
const batchImportDialog= ref(false)
const importText       = ref('')
const importGroup      = ref('')
const importPlatform   = ref('')
const importSaving     = ref(false)
const assignDialog     = ref(false)
const assignAccountId  = ref(null)
const assignSaving     = ref(false)
const autoAssigning    = ref(false)
const directAdding     = ref(false)

async function loadProxyData() {
  proxyLoading.value = true
  try {
    const res = await getProxyPool({ limit: 1000 })
    proxyRows.value = res.data.data
  } finally { proxyLoading.value = false }
}
async function loadProxyStats()    { const r = await getProxyPoolStats(); Object.assign(proxyStats, r.data) }
function loadProxyAll() { loadProxyData(); loadProxyStats(); loadEnabledAccounts() }

function openEditProxy(row) {
  editProxyRow.value = row
  Object.assign(editProxyForm, {
    host: row.host || '', port: row.port || null,
    username: row.username || '', password: row.password || '',
    group_name: row.group_name || '', platform: row.platform || '', expire_time: row.expire_time || '',
  })
  editProxyDialog.value = true
}
async function saveProxy() {
  if (!editProxyForm.host || !editProxyForm.port) return ElMessage.warning('IP 和端口必填')
  if (!isDatetime(editProxyForm.expire_time)) return ElMessage.error('过期时间格式不正确')
  editProxySaving.value = true
  try {
    await updateProxyEntry(editProxyRow.value.id, editProxyForm)
    editProxyDialog.value = false
    ElMessage.success('保存成功')
    loadProxyAll()
  } finally { editProxySaving.value = false }
}
async function doDeleteProxy(row) {
  const label = row.proxy_type === 'direct' ? `本机直连（${row.real_ip || '未知IP'}）` : `${row.host}:${row.port}`
  await ElMessageBox.confirm(`删除代理 ${label}？`, '确认删除', { type: 'warning' })
  await deleteProxyEntry(row.id)
  ElMessage.success('已删除')
  loadProxyAll()
}
async function doAddDirect() {
  directAdding.value = true
  try {
    await addDirectProxy()
    ElMessage.success('本机直连代理已添加/更新')
    loadProxyAll()
  } catch (_) {} finally { directAdding.value = false }
}
async function toggleProxyEnabled(row, v) {
  await batchOpsProxy({ action: v ? 'enable' : 'disable', ids: [row.id] })
  loadProxyAll()
}
async function toggleProxyOpsEnabled(row, v) {
  await batchOpsProxy({ action: v ? 'ops_enable' : 'ops_disable', ids: [row.id] })
  loadProxyAll()
}
async function proxyBatchOp(action) {
  const ids = proxySelected.value.map(r => r.id)
  if (action === 'delete') await ElMessageBox.confirm(`确定删除 ${ids.length} 条代理？`, '确认', { type: 'warning' })
  await batchOpsProxy({ action, ids })
  ElMessage.success(`操作完成（${ids.length} 条）`)
  loadProxyAll()
}
function openAssignDialog() { assignAccountId.value = null; assignDialog.value = true }
async function doAssign() {
  if (!assignAccountId.value) return ElMessage.warning('请选择目标账号')
  assignSaving.value = true
  try {
    const ids = proxySelected.value.map(r => r.id)
    await batchAssign(ids, assignAccountId.value)
    ElMessage.success(`已将 ${ids.length} 条代理分配给该账号`)
    assignDialog.value = false
    loadProxyAll()
  } finally { assignSaving.value = false }
}
async function doAutoAssignAll() {
  autoAssigning.value = true
  try {
    const res = await autoAssignAll()
    const d = res.data
    if (d.totalAssigned === 0) ElMessage.info(`所有账号代理已满（处理了 ${d.accountsProcessed} 个账号）`)
    else ElMessage.success(`自动分配完成：为 ${d.details.length} 个账号补充了 ${d.totalAssigned} 条代理`)
    loadProxyAll()
  } finally { autoAssigning.value = false }
}
async function startBatchTestJob() {
  const ids = proxySelected.value.map(r => r.id)
  batchTesting.value = true
  try { const r = await startBatchTest(ids); pollProxyJob(r.data.jobId) }
  catch (_) { batchTesting.value = false }
}
async function startBatchAfdJob() {
  const ids = proxySelected.value.map(r => r.id)
  batchAfdRunning.value = true
  try { const r = await startBatchAfd(ids); pollProxyJob(r.data.jobId) }
  catch (_) { batchAfdRunning.value = false }
}
function pollProxyJob(jobId) {
  if (proxyJobTimer) clearInterval(proxyJobTimer)
  proxyJobTimer = setInterval(async () => {
    try {
      const r = await getProxyJob(jobId)
      activeProxyJob.value = r.data
      if (r.data.status === 'done') {
        clearInterval(proxyJobTimer); batchTesting.value = false; batchAfdRunning.value = false
        loadProxyData(); loadProxyStats()
      }
    } catch (_) { clearInterval(proxyJobTimer) }
  }, 2000)
}
async function doBatchImport() {
  if (!importText.value.trim()) return ElMessage.warning('请输入代理数据')
  importSaving.value = true
  try {
    const res = await batchImportProxies({ text: importText.value, group_name: importGroup.value || null, platform: importPlatform.value || null })
    const d = res.data
    ElMessage.success(`导入完成：新增 ${d.imported} 条，跳过 ${d.skipped} 条`)
    batchImportDialog.value = false; importText.value = ''
    loadProxyAll()
    if (d.ids && d.ids.length > 0) {
      ElMessage.info(`正在自动测试 ${d.ids.length} 条新代理...`)
      const jr = await startBatchTest(d.ids); pollProxyJob(jr.data.jobId)
    }
  } finally { importSaving.value = false }
}

// ─────────────────────────────────────────────────────────
// SSH 隧道代理
// ─────────────────────────────────────────────────────────
const sshLoading         = ref(false)
const sshRows            = ref([])
const sshFilterRisk      = ref('')
const sshSelected        = ref([])
const sshStats           = reactive({})
const activeSshJob       = ref(null)
const sshBatchTesting    = ref(false)
const sshBatchAfdRunning = ref(false)
let   sshJobTimer        = null

const sshSyncDialog      = ref(false)
const sshSyncPath        = ref('E:\\gamyy_proxy\\cloud_proxy_pool\\proxy_manager.db')
const sshSyncing         = ref(false)
const sshBatchImportDialog   = ref(false)
const sshBatchImportText     = ref('')
const sshBatchImportGroup    = ref('')
const sshBatchImportPlatform = ref('')
const sshBatchImporting      = ref(false)
const sshAssignDialog    = ref(false)
const sshAssignAccountId = ref(null)
const sshAssignSaving    = ref(false)
const sshAutoAssigning   = ref(false)

const filteredSshRows = computed(() => {
  if (sshFilterRisk.value === '') return sshRows.value
  const flag = sshFilterRisk.value === '1'
  return sshRows.value.filter(r => !!r.is_risk_flagged === flag)
})

async function loadSshData() {
  sshLoading.value = true
  try {
    await autoFillAgentUrls().catch(() => {})
    const res = await getProxyPool({ proxy_type: 'ssh', limit: 1000 })
    sshRows.value = res.data.data
  } finally { sshLoading.value = false }
}
async function loadSshStats() { const r = await getSshProxyStats(); Object.assign(sshStats, r.data) }
function loadSshAll() { loadSshData(); loadSshStats(); loadEnabledAccounts() }

async function doSshSync() {
  if (!sshSyncPath.value.trim()) return ElMessage.warning('请输入 DB 路径')
  sshSyncing.value = true
  try {
    const res = await sshSyncFromDb(sshSyncPath.value.trim())
    const d = res.data
    ElMessage.success(`同步完成：新增 ${d.inserted} 条，更新 ${d.updated} 条（共 ${d.total} 条活跃代理）`)
    sshSyncDialog.value = false
    loadSshAll()
  } finally { sshSyncing.value = false }
}
async function doSshBatchImport() {
  const text = sshBatchImportText.value.trim()
  if (!text) return ElMessage.warning('请粘贴要导入的 IP 列表')
  sshBatchImporting.value = true
  try {
    const res = await sshBatchImport(text, sshBatchImportGroup.value.trim() || null, sshBatchImportPlatform.value.trim() || null)
    const d = res.data
    const errCount = (d.errors || []).length
    const msg = `导入完成：新增 ${d.inserted}、更新 ${d.updated}、跳过 ${d.skipped}（共 ${d.total} 行）`
    if (errCount > 0) {
      const preview = d.errors.slice(0, 5).map(e => `「${e.line}」${e.reason}`).join('\n')
      ElMessageBox.alert(`${msg}\n\n失败 ${errCount} 行：\n${preview}${errCount > 5 ? '\n…' : ''}`, '导入结果', { type: 'warning' })
    } else {
      ElMessage.success(msg)
    }
    sshBatchImportDialog.value = false
    sshBatchImportText.value = ''
    loadSshAll()
  } finally { sshBatchImporting.value = false }
}
async function toggleSshEnabled(row, v) {
  await batchOpsProxy({ action: v ? 'enable' : 'disable', ids: [row.id] })
  loadSshAll()
}
async function toggleSshOpsEnabled(row, v) {
  await batchOpsProxy({ action: v ? 'ops_enable' : 'ops_disable', ids: [row.id] })
  loadSshAll()
}
async function sshBatchOp(action) {
  const ids = sshSelected.value.map(r => r.id)
  if (action === 'delete') await ElMessageBox.confirm(`确定删除 ${ids.length} 条 SSH 代理？`, '确认', { type: 'warning' })
  await batchOpsProxy({ action, ids })
  ElMessage.success(`操作完成（${ids.length} 条）`)
  loadSshAll()
}
function openSshAssignDialog() { sshAssignAccountId.value = null; sshAssignDialog.value = true }
async function doSshAssign() {
  if (!sshAssignAccountId.value) return ElMessage.warning('请选择目标账号')
  sshAssignSaving.value = true
  try {
    const ids = sshSelected.value.map(r => r.id)
    await batchAssign(ids, sshAssignAccountId.value)
    ElMessage.success(`已将 ${ids.length} 条 SSH 代理分配给该账号`)
    sshAssignDialog.value = false
    loadSshAll()
  } finally { sshAssignSaving.value = false }
}
async function doSshAutoAssignAll() {
  sshAutoAssigning.value = true
  try {
    const res = await autoAssignAll()
    const d = res.data
    if (d.totalAssigned === 0) ElMessage.info(`所有账号代理已满（处理了 ${d.accountsProcessed} 个账号）`)
    else ElMessage.success(`自动分配完成：为 ${d.details.length} 个账号补充了 ${d.totalAssigned} 条代理`)
    loadSshAll()
  } finally { sshAutoAssigning.value = false }
}
async function doDeleteSsh(row) {
  const label = row.port ? `127.0.0.1:${row.port}（云服务器 ${row.real_ip}）` : `云服务器 ${row.real_ip}（仅云端）`
  await ElMessageBox.confirm(`删除 SSH 代理 ${label}？`, '确认删除', { type: 'warning' })
  await deleteProxyEntry(row.id)
  ElMessage.success('已删除')
  loadSshAll()
}

const sshAgentChecking   = ref(false)
const sshAgentResults    = ref(null)

async function doBatchCheckAgents() {
  const ids = sshSelected.value.length > 0 ? sshSelected.value.map(r => r.id) : undefined
  sshAgentChecking.value = true
  sshAgentResults.value = null
  try {
    const res = await batchCheckCloudAgents(ids)
    if (res.data.length === 0) { ElMessage.info('没有配置云端 Agent URL 的 SSH 代理'); return }
    sshAgentResults.value = res.data
  } catch (e) {
    ElMessage.error(`检测失败: ${e.message}`)
  } finally {
    sshAgentChecking.value = false
  }
}

const sshEditDialog      = ref(false)
const sshEditRow         = ref(null)
const sshEditForm        = reactive({ cloud_agent_url: '' })
const sshEditSaving      = ref(false)
const sshHealthChecking  = ref(false)
const sshHealthResult    = ref(null)

function openSshEdit(row) {
  sshEditRow.value = row
  sshEditForm.cloud_agent_url = row.cloud_agent_url || (row.real_ip ? `http://${row.real_ip}:7070` : '')
  sshHealthResult.value = null
  sshEditDialog.value = true
}
async function saveSshEdit() {
  sshEditSaving.value = true
  try {
    await setProxyCloudAgent(sshEditRow.value.id, sshEditForm.cloud_agent_url || null)
    ElMessage.success('保存成功')
    sshEditDialog.value = false
    loadSshAll()
  } finally { sshEditSaving.value = false }
}
async function doSshHealthCheck() {
  if (!sshEditForm.cloud_agent_url) { ElMessage.warning('请先输入 Agent URL'); return }
  // 先保存，再检测
  sshEditSaving.value = true
  try { await setProxyCloudAgent(sshEditRow.value.id, sshEditForm.cloud_agent_url) } catch (_) {}
  finally { sshEditSaving.value = false }

  sshHealthChecking.value = true
  sshHealthResult.value = null
  try {
    const res = await checkProxyCloudAgent(sshEditRow.value.id)
    const d = res.data
    sshHealthResult.value = { ok: true, msg: `✅ Agent 在线 | 运行时间 ${d.uptime}s | 运行中任务 ${d.runningTasks}` }
    loadSshAll()
  } catch (e) {
    sshHealthResult.value = { ok: false, msg: `❌ 连接失败: ${e.response?.data?.error || e.message}` }
  } finally { sshHealthChecking.value = false }
}
async function startSshBatchTestJob() {
  const ids = sshSelected.value.map(r => r.id)
  sshBatchTesting.value = true
  try { const r = await startBatchTest(ids); pollSshJob(r.data.jobId) }
  catch (_) { sshBatchTesting.value = false }
}
async function startSshBatchAfdJob() {
  const ids = sshSelected.value.map(r => r.id)
  sshBatchAfdRunning.value = true
  try { const r = await startBatchAfd(ids); pollSshJob(r.data.jobId) }
  catch (_) { sshBatchAfdRunning.value = false }
}
function pollSshJob(jobId) {
  if (sshJobTimer) clearInterval(sshJobTimer)
  sshJobTimer = setInterval(async () => {
    try {
      const r = await getProxyJob(jobId)
      activeSshJob.value = r.data
      if (r.data.status === 'done') {
        clearInterval(sshJobTimer); sshBatchTesting.value = false; sshBatchAfdRunning.value = false
        loadSshData(); loadSshStats()
      }
    } catch (_) { clearInterval(sshJobTimer) }
  }, 2000)
}

// ─────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────
onMounted(() => {
  loadProxyAll()
})
onUnmounted(() => {
  if (proxyJobTimer) clearInterval(proxyJobTimer)
  if (sshJobTimer)   clearInterval(sshJobTimer)
})
</script>

<style scoped>
.proxy-pool-root { height: 100%; display: flex; flex-direction: column; }

.main-tabs { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.main-tabs :deep(.el-tabs__content) { flex: 1; overflow: auto; padding: 0; }
.main-tabs :deep(.el-tab-pane) { height: 100%; }

.tab-content { display: flex; flex-direction: column; gap: 10px; padding: 12px; height: 100%; box-sizing: border-box; }

.toolbar {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 8px;
  background: #fff; border-radius: 6px; padding: 10px 14px;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
}
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; color: #606266; }

.data-table { flex: 1; }

.mono { font-family: monospace; font-size: 12px; }

.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
.dot-on  { background: #67c23a; box-shadow: 0 0 5px rgba(103,194,58,.7); }
.dot-off { background: #f56c6c; box-shadow: 0 0 4px rgba(245,108,108,.5); }

.data-table :deep(tr.row-risk td) { background-color: rgba(245,108,108,.07) !important; }
</style>
