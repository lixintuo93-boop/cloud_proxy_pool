<template>
  <MainLayout>
    <div class="accounts-page">

      <!-- ─── 顶部工具栏 ─── -->
      <div class="top-toolbar">
        <div class="toolbar-left">
          <el-input
            v-model="filterMobile"
            size="small" placeholder="搜索手机号" clearable
            style="width:160px"
          />
          <el-select v-model="filterEnabled" size="small" placeholder="全部" clearable style="width:80px">
            <el-option label="启用" value="1" />
            <el-option label="禁用" value="0" />
          </el-select>
          <el-select v-model="filterRisk" size="small" placeholder="全部" clearable style="width:80px">
            <el-option label="风控" value="1" />
            <el-option label="正常" value="0" />
          </el-select>
          <el-select v-model="filterBanned" size="small" placeholder="全部" clearable style="width:80px">
            <el-option label="封号" value="1" />
            <el-option label="未封" value="0" />
          </el-select>
        </div>

        <div class="toolbar-middle">
          <a class="sel-link" @click.prevent="selectAll">全选</a>
          <template v-if="selectedBatchIds.size > 0">
            <span class="sel-count">已选 {{ selectedBatchIds.size }} 个</span>
            <a class="sel-link" @click.prevent="clearBatchSelect">清空</a>
          </template>
          <el-divider direction="vertical" style="margin:0 4px;height:16px" />
          <el-button size="small" type="success" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchEnable">启用</el-button>
          <el-button size="small" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchDisable">禁用</el-button>
          <el-divider direction="vertical" style="margin:0 4px;height:16px" />
          <el-button size="small" type="primary" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchOp('login')">登录</el-button>
          <el-button size="small" type="success" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchOp('user-behavior')">执行用户行为</el-button>
          <el-button size="small" type="info"    plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchOp('messages')">获取消息</el-button>
          <el-button size="small" type="info"    plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchOp('source-records')">获取挂号记录</el-button>
          <el-button size="small" type="primary" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="openBatchAddPatient">批量添患者</el-button>
          <el-button size="small" type="warning" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchStartTasks">启任务</el-button>
          <el-button size="small" type="danger" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchStopTasks">停任务</el-button>
          <el-button size="small" type="primary" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="openBatchCreateTasks">建任务</el-button>
          <el-button size="small" type="danger" plain :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchDeleteTasks">删任务</el-button>
          <el-divider direction="vertical" style="margin:0 4px;height:16px" />
          <el-button size="small" type="danger" :disabled="selectedBatchIds.size === 0 || batchRunning" @click="runBatchDeleteAccounts">批量删账号</el-button>
        </div>

        <div class="toolbar-right">
          <el-button size="small" :loading="autoAssignOpsRunning" @click="doAutoAssignOpsAll">自动分配操作代理</el-button>
          <el-button size="small" :icon="Plus" @click="generateDialog = true">添加账号</el-button>
          <el-button size="small" @click="openBatchRegisterDialog">批量注册</el-button>
        </div>
      </div>

      <!-- ─── 账号列表 ─── -->
      <div class="account-list" v-loading="loading">

        <div
          v-for="acct in filtered"
          :key="acct.id"
          class="acct-row-wrap"
          :class="{ 'is-expanded': expandedIds.has(acct.id) }"
        >
          <!-- 账号主行 -->
          <div
            class="acct-row"
            :class="{
              'is-enabled':  acct.enabled === 1,
              'is-disabled': acct.enabled === 0,
              'is-sel':      selectedBatchIds.has(acct.id),
              'has-sel':     selectedBatchIds.size > 0,
              'is-risk':     acct.is_risk_flagged === 1,
              'is-banned':   acct.is_banned === 1,
            }"
            @click="toggleExpand(acct.id)"
          >
            <el-checkbox
              class="row-checkbox"
              :model-value="selectedBatchIds.has(acct.id)"
              @click.stop
              @change="toggleBatchSelect(acct.id)"
            />

            <span
              class="acct-mobile acct-mobile-copy"
              title="点击复制 手机号 / 密码 / UUID"
              @click.stop="copyAccountInfo(acct)"
            >{{ acct.mobile }}</span>
            <el-tag v-if="acct.is_banned" type="danger" size="small" class="acct-type-tag" style="background:#7c3aed;border-color:#7c3aed;color:#fff">封号</el-tag>
            <el-tag v-if="acct.is_risk_flagged" type="danger" size="small" class="acct-type-tag">风控</el-tag>
            <el-tag
              size="small"
              :type="acct.account_type === 'wechat' ? '' : 'warning'"
              class="acct-type-tag"
            >
              {{ acct.account_type === 'wechat' ? '微信' : ('App/' + (acct.account_platform === 'ios' ? 'iOS' : 'Android')) }}
            </el-tag>
            <span
              v-if="acct.account_type !== 'wechat' && acct.password"
              class="acct-info-pill acct-password-pill"
              title="App 端密码（明文）"
            >🔑 {{ acct.password }}</span>
            <span
              v-if="acct.device_uuid"
              class="acct-info-pill acct-uuid-pill"
              title="设备 UUID"
            >📱 {{ acct.device_uuid }}</span>

            <el-switch
              :model-value="acct.enabled === 1"
              size="small"
              @click.stop
              @change="(v) => toggleEnabled(acct, v)"
              style="flex-shrink:0"
            />

            <!-- 就诊人图标区 -->
            <div class="patient-area">
              <el-tooltip
                v-for="p in (patientsMap[acct.id] || []).slice(0, 5)"
                :key="p.id"
                placement="top"
                :show-after="200"
              >
                <template #content>
                  <div>姓名：{{ p.name }}</div>
                  <div>性别：{{ p.gender || '—' }}</div>
                  <div>年龄：{{ p.age != null ? p.age + ' 岁' : '—' }}</div>
                </template>
                <span class="patient-icon-wrap">
                  <span class="patient-emoji">{{ patientIcon(p) }}</span>
                  <span class="patient-del" @click.stop="quickDeletePatient(acct, p)" title="删除就诊人">×</span>
                </span>
              </el-tooltip>
              <span class="patient-add" @click.stop="openAddPatient(acct)" title="添加就诊人">+</span>
            </div>

            <!-- 代理配置 -->
            <span class="proxy-badge" :class="{ 'proxy-badge-dim': acct.enabled === 0 }">
              任务代理{{ acct.proxy_count }}/{{ acct.proxy_max_count || defaultProxyMaxCount }}
            </span>
            <el-input-number
              :model-value="acct.proxy_max_count || defaultProxyMaxCount"
              @click.stop
              @change="(v) => updateProxyMax(acct, v)"
              :min="1" :max="200" :controls="false"
              size="small" style="width:58px;flex-shrink:0"
              :disabled="accountHasRunningTask(acct.id)"
              title="任务代理上限"
            />
            <el-button
              size="small" plain style="flex-shrink:0;padding:5px 8px"
              @click.stop="doAutoAssignProxy(acct)"
              :disabled="accountHasRunningTask(acct.id)"
              :title="accountHasRunningTask(acct.id) ? '任务运行中，请先停止后再分配代理' : '自动分配任务代理'"
            >分配</el-button>
            <!-- 操作代理 -->
            <span
              class="ops-proxy-badge"
              :class="{ 'ops-proxy-badge-set': !!acct.ops_proxy_label }"
              @click.stop="openOpsProxyDialog(acct)"
              :title="acct.ops_proxy_label ? `操作代理: ${acct.ops_proxy_label}（点击更改）` : '点击分配操作代理'"
            >操作: {{ acct.ops_proxy_label || '未设置' }}</span>

            <div style="flex:1;min-width:12px" />

            <!-- 任务状态点 -->
            <div class="task-dots">
              <span
                v-for="task in (accountTasksMap[acct.id] || [])"
                :key="task.id"
                class="task-dot"
                :class="isRunning(task.id) ? 'dot-on' : 'dot-off'"
                :title="`${task.doctor_code || '?'} ${task.lock_plan_date || ''}`"
              />
            </div>

            <el-button
              size="small" text
              class="acct-op-btn"
              title="获取挂号记录"
              @click.stop="handleOp(acct.id, 'source-records')"
            >挂号记录</el-button>
            <el-button
              size="small" text
              class="acct-op-btn"
              title="获取消息"
              @click.stop="handleOp(acct.id, 'messages')"
            >消息</el-button>
            <el-button
              size="small" text
              class="acct-op-btn"
              title="查看请求记录"
              @click.stop="openReqLogDialog(acct.id)"
            >请求记录</el-button>

            <el-button
              size="small" text :icon="Delete"
              class="acct-del-btn"
              title="删除账号"
              @click.stop="handleDeleteAccount(acct)"
            />

            <el-button
              size="small" text
              class="expand-btn"
              @click.stop="toggleExpand(acct.id)"
            >
              <span class="expand-arrow">{{ expandedIds.has(acct.id) ? '▲' : '▼' }}</span>
              <span>任务</span>
              <span v-if="(accountTasksMap[acct.id] || []).length > 0" class="expand-count">{{ (accountTasksMap[acct.id] || []).length }}</span>
            </el-button>
          </div>

          <!-- 展开的任务列表 -->
          <div v-if="expandedIds.has(acct.id)" class="task-section">
            <div class="task-section-header">
              <b style="font-size:13px;color:#303133">任务列表</b>
              <el-button size="small" type="primary" :icon="Plus" @click="openCreateTask(acct)">
                新建任务
              </el-button>
            </div>
            <div v-if="(accountTasksMap[acct.id] || []).length === 0" class="tasks-empty">
              该账号暂无任务
            </div>
            <div v-for="task in (accountTasksMap[acct.id] || [])" :key="task.id" class="task-item">
              <div class="task-item-header">
                <div class="task-item-left">
                  <span class="task-dot task-item-dot" :class="isRunning(task.id) ? 'dot-on' : 'dot-off'" />
                  <span class="task-target">
                    <span class="task-doctor">{{ getDoctorDisplay(task) }}</span>
                    <span class="task-date">{{ task.lock_plan_date || '—' }}</span>
                    <span class="task-patient">{{ getPatientName(task) }}</span>
                  </span>
                  <TaskStatusBadge :status="runtimeStatus[task.id]?.status" :stop-reason="runtimeStatus[task.id]?.stopReason" :enabled="task.enabled" />
                </div>
                <div class="task-item-right">
                  <el-button-group>
                    <el-button v-if="!isRunning(task.id)" size="small" type="primary" plain @click="handleStart(task)">启动</el-button>
                    <el-button v-else size="small" type="danger" plain @click="handleStop(task)">停止</el-button>
                    <el-button size="small" @click="openConfig(task)" :disabled="isRunning(task.id)" :title="isRunning(task.id) ? '任务运行中，请先停止后再修改配置' : ''">配置</el-button>
                    <el-button size="small" type="danger" plain @click="handleDeleteTask(task)">删除</el-button>
                  </el-button-group>
                </div>
              </div>
              <div v-if="(taskProxiesMap[task.id] || []).length > 0" class="task-proxy-panel">
                <template v-for="p in taskProxiesMap[task.id]" :key="p.id">
                  <div class="proxy-stat-row" :class="{ 'proxy-row-risk': p.is_risk_flagged }">
                    <span class="proxy-ip">{{ formatProxyIp(task.id, p) }}</span>
                    <span
                      class="proxy-cfg-btn"
                      :class="{ 'proxy-cfg-disabled': isRunning(task.id) }"
                      :title="isRunning(task.id) ? '任务运行中，请先停止后再修改配置' : '配置此代理的全部参数'"
                      @click.stop="!isRunning(task.id) && openProxyOverride(task.id, p)"
                    >⚙</span>
                    <template v-for="cfg in [getEffectiveCfg(task, p)]" :key="'c'">
                      <!-- 通道段 -->
                      <span class="proxy-ch task-meta-mono" :class="{ 'proxy-ch-ov': cfg.chBuildStart.override }" title="通道创建开始时间">建:{{ cfg.chBuildStart.value || '—' }}</span>
                      <span class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.chBuildWindow.override }" title="通道创建窗口">建窗:{{ msToDisp(cfg.chBuildWindow.value) }}</span>
                      <span class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.chBuildAttempts.override }" title="尝试创建次数">建×{{ cfg.chBuildAttempts.value ?? '—' }}</span>
                      <!-- 查号段 -->
                      <span class="proxy-ch" :title="cfg.checkMode.title">{{ cfg.checkMode.value }}</span>
                      <span class="proxy-ch task-meta-mono" :class="{ 'proxy-ch-ov': cfg.startTime.override }" title="查票开始时间">{{ cfg.startTime.value || '—' }}</span>
                      <span class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.windowTime.override }" title="查票窗口">窗:{{ msToDisp(cfg.windowTime.value) }}</span>
                      <span class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.stopAfter.override }" title="找到几次后停止">×{{ fmtStopShort(cfg.stopAfter.value) }}</span>
                      <!-- 锁号段 -->
                      <span v-if="cfg.lockStart.value" class="proxy-ch task-meta-mono" :class="{ 'proxy-ch-ov': cfg.lockStart.override }" title="锁号开始时间">锁开:{{ cfg.lockStart.value }}</span>
                      <span class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.lockWindow.override }" title="锁号窗口">锁窗:{{ msToDisp(cfg.lockWindow.value) }}</span>
                      <span class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.sign.override }" title="SubmitSign 策略">Sign:{{ cfg.sign.value }}</span>
                      <!-- 目标主机段 -->
                      <span v-if="cfg.targetHosts.value" class="proxy-ch" :class="{ 'proxy-ch-ov': cfg.targetHosts.override }" :title="cfg.targetHosts.title">→{{ cfg.targetHosts.value }}</span>
                    </template>
                    <template v-for="s in [getLiveProxyStat(task.id, p)]" :key="0">
                      <template v-if="s">
                        <span v-if="s.runMode" class="proxy-run-mode" :class="s.runMode === 'cloud' ? 'run-mode-cloud' : 'run-mode-local'">{{ s.runMode === 'cloud' ? '云端' : '本地' }}</span>
                        <span class="proxy-seg">通道:{{ s.channels.connected }}/{{ s.channels.total }}(空闲:{{ s.channels.idle }})[P1:{{ s.phase1.success }}/{{ s.phase1.total }}]</span>
                        <span class="proxy-seg">查:{{ s.check.scheduled }}调/{{ s.check.sent }}发/{{ s.check.total }}完(✓{{ s.check.success }}✗{{ s.check.failed }})</span>
                        <span class="proxy-seg">锁:{{ s.lock.scheduled }}调/{{ s.lock.sent }}发/{{ s.lock.total }}完(✓{{ s.lock.success }}✗{{ s.lock.failed }})</span>
                        <span class="proxy-seg proxy-hb">心跳:{{ s.heartbeat?.success ?? 0 }}/{{ s.heartbeat?.total ?? 0 }}</span>
                        <span v-if="s.lock.success > 0" class="proxy-lock-ok">锁号成功×{{ s.lock.success }}</span>
                      </template>
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!loading && filtered.length === 0" class="list-empty">
          <el-icon size="28" color="#c0c4cc"><User /></el-icon>
          <p>{{ accounts.length === 0 ? '暂无账号' : '无匹配账号' }}</p>
        </div>
      </div>

      <div class="list-footer">{{ filtered.length }} / {{ accounts.length }} 个账号</div>
    </div>

    <!-- 新建任务对话框 -->
    <el-dialog v-model="taskDialog" :title="`为 ${taskTargetAccount?.mobile} 新建任务`" width="480px">
      <el-form :model="taskForm" label-width="90px">
        <el-form-item label="目标医生">
          <el-select
            v-model="taskForm.doctor_code"
            :filter-method="filterDoctors"
            filterable clearable
            placeholder="输入医生姓名或编码搜索"
            style="width:100%"
          >
            <el-option
              v-for="d in filteredDoctors"
              :key="d.doctor_code"
              :label="`${d.doctor_code} · ${d.doctor_name}`"
              :value="d.doctor_code"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标日期">
          <el-date-picker
            v-model="taskForm.lock_plan_date"
            type="date" value-format="YYYY-MM-DD"
            placeholder="锁号目标日期" style="width:180px"
          />
        </el-form-item>
        <el-form-item label="就诊人">
          <el-select
            v-model="taskForm.patient_id"
            :loading="patientsLoading"
            :placeholder="patients.length ? '请选择就诊人' : '该账号无就诊人'"
            clearable style="width:100%"
            :disabled="patientsLoading"
          >
            <el-option
              v-for="p in patients"
              :key="p.id"
              :label="`${p.name}${p.gender ? ' ' + p.gender : ''}${p.age != null ? ' ' + p.age + '岁' : ''}`"
              :value="p.id"
            >
              <span style="font-weight:500">{{ p.name }}</span>
              <span style="color:#909399;font-size:12px;margin-left:8px">
                {{ p.gender }}{{ p.age != null ? ' ' + p.age + '岁' : '' }} · {{ p.id }}
              </span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="代理模板">
          <el-select
            v-model="taskForm.proxy_template_ids"
            multiple clearable
            placeholder="不选则保持各代理当前配置；多选时按代理依次轮询"
            style="width:100%"
          >
            <el-option
              v-for="t in templates"
              :key="t.id"
              :label="t.name"
              :value="t.id"
            >
              <span>{{ t.name }}</span>
              <span v-if="t.name === '默认配置'" style="color:#e6a23c;font-size:11px;margin-left:6px">默认</span>
              <span v-if="t.description" style="color:#909399;font-size:12px;margin-left:8px">{{ t.description }}</span>
            </el-option>
          </el-select>
          <div style="margin-top:4px;color:#909399;font-size:12px">
            该任务下的代理按代理 ID 顺序轮询应用所选模板（不同代理可拿不同模板）
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="taskDialog = false">取消</el-button>
        <el-button type="primary" :loading="taskSaving" @click="doCreateTask">创建任务</el-button>
      </template>
    </el-dialog>

    <!-- 批量建任务弹窗 -->
    <el-dialog v-model="batchTaskDialog" title="批量建任务" width="480px" :append-to-body="true">
      <el-form :model="batchTaskForm" label-width="90px">
        <el-form-item label="目标医生">
          <el-select
            v-model="batchTaskForm.doctor_codes"
            :filter-method="filterDoctors"
            multiple filterable clearable
            placeholder="输入医生姓名或编码搜索；多选时轮转分配"
            style="width:100%"
          >
            <el-option
              v-for="d in filteredDoctors"
              :key="d.doctor_code"
              :label="`${d.doctor_code} · ${d.doctor_name}`"
              :value="d.doctor_code"
            />
          </el-select>
          <div v-if="batchTaskForm.doctor_codes.length > 1" style="margin-top:4px;color:#909399;font-size:12px">
            已选 {{ batchTaskForm.doctor_codes.length }} 个医生，将轮转分配给 {{ selectedEnabledCount }} 个账号
          </div>
        </el-form-item>
        <el-form-item label="目标日期">
          <el-date-picker
            v-model="batchTaskForm.lock_plan_date"
            type="date" value-format="YYYY-MM-DD"
            placeholder="锁号目标日期" style="width:180px"
          />
        </el-form-item>
        <el-form-item label="代理模板">
          <el-select
            v-model="batchTaskForm.proxy_template_ids"
            multiple clearable
            placeholder="不选则保持代理现有配置；多选时按账号顺序轮转"
            style="width:100%"
          >
            <el-option
              v-for="t in templates"
              :key="t.id"
              :label="t.name"
              :value="t.id"
            >
              <span>{{ t.name }}</span>
              <span v-if="t.name === '默认配置'" style="color:#e6a23c;font-size:11px;margin-left:6px">默认</span>
              <span v-if="t.description" style="color:#909399;font-size:12px;margin-left:8px">{{ t.description }}</span>
            </el-option>
          </el-select>
          <div v-if="batchTaskForm.proxy_template_ids.length > 1" style="margin-top:4px;color:#909399;font-size:12px">
            已选 {{ batchTaskForm.proxy_template_ids.length }} 个模板，将轮转分配给 {{ selectedEnabledCount }} 个账号下的代理
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchTaskDialog = false">取消</el-button>
        <el-button type="primary" :loading="batchRunning" @click="doRunBatchCreateTasks">开始创建</el-button>
      </template>
    </el-dialog>

    <!-- 批量添患者弹窗 -->
    <el-dialog v-model="batchPatientDialog" title="批量添加患者" width="340px" :append-to-body="true">
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0 10px">
        <span style="font-size:13px;color:#606266;flex-shrink:0">年龄范围</span>
        <el-input-number v-model="batchPatientMinAge" :min="1" :max="99" :controls="false" size="small" style="width:60px" />
        <span style="color:#909399;font-size:13px">—</span>
        <el-input-number v-model="batchPatientMaxAge" :min="1" :max="99" :controls="false" size="small" style="width:60px" />
        <span style="color:#909399;font-size:12px">岁</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0 12px">
        <span style="font-size:13px;color:#606266;flex-shrink:0">性别</span>
        <el-radio-group v-model="batchPatientGender" size="small">
          <el-radio-button value="">随机</el-radio-button>
          <el-radio-button value="male">男</el-radio-button>
          <el-radio-button value="female">女</el-radio-button>
        </el-radio-group>
      </div>
      <p style="color:#909399;font-size:12px;margin:0">
        将为 {{ selectedEnabledCount }} 个启用账号各自生成独立患者信息并绑定
      </p>
      <template #footer>
        <el-button @click="batchPatientDialog = false">取消</el-button>
        <el-button type="primary" @click="doRunBatchAddPatient">开始</el-button>
      </template>
    </el-dialog>

    <!-- 任务配置弹窗 -->
    <TaskConfigDialog
      v-model="configDialogVisible"
      :task-id="configTaskId"
      @closed="reloadTasks"
    />

    <!-- 账号操作日志弹窗 -->
    <el-dialog
      v-model="opLogDialog"
      :title="opDialogTitle"
      width="720px"
      :close-on-click-modal="!opRunning"
      :close-on-press-escape="!opRunning"
    >
      <div v-if="opRunning" class="op-running">
        <el-icon class="is-loading" style="font-size:18px;margin-right:8px"><Loading /></el-icon>
        <span>正在执行，请稍候…</span>
      </div>
      <div v-if="opLogs.length > 0" class="op-log-box">
        <div v-for="(line, i) in opLogs" :key="i" class="op-log-line">{{ line }}</div>
      </div>
      <el-alert
        v-if="opError && !opRunning"
        type="error"
        :title="opError"
        :closable="false"
        style="margin-top:10px"
      />
      <div v-if="opResult && !opError && !opRunning" style="margin-top:10px;display:flex;align-items:center;gap:10px">
        <el-tag type="success">操作成功</el-tag>
        <span v-if="opResult.savedCount != null" style="font-size:13px;color:#606266">
          共保存 {{ opResult.savedCount }} 条
        </span>
        <span v-if="opResult.code === 0" style="font-size:13px;color:#606266">
          {{ opResult.msg || '' }}
        </span>
      </div>
      <div v-if="opRecords.length > 0" style="margin-top:14px">
        <div style="font-weight:600;margin-bottom:6px;font-size:14px">挂号记录（{{ opRecords.length }} 条）</div>
        <el-table
          ref="recordTableRef"
          :data="opRecords" size="small" max-height="420" border
          row-key="source_trade_id"
          :expand-row-keys="expandedRecordKeys"
          @row-click="toggleRecordExpand"
          style="cursor:pointer"
        >
          <el-table-column type="expand" width="1">
            <template #default="{ row }">
              <div class="record-detail-expand">
                <div class="record-detail-grid">
                  <div class="rd-item"><span class="rd-label">记录ID</span><span class="rd-value">{{ row.record_id || '—' }}</span></div>
                  <div class="rd-item"><span class="rd-label">患者ID</span><span class="rd-value">{{ row.patient_id || '—' }}</span></div>
                  <div class="rd-item"><span class="rd-label">医生编码</span><span class="rd-value">{{ row.doctor_code || '—' }}</span></div>
                  <div class="rd-item"><span class="rd-label">科室编码</span><span class="rd-value">{{ row.dept_code || '—' }}</span></div>
                  <div class="rd-item"><span class="rd-label">就诊序号</span><span class="rd-value">{{ row.visit_no || '—' }}</span></div>
                  <div class="rd-item"><span class="rd-label">支付状态</span><span class="rd-value">{{ row.pay_status || '—' }}</span></div>
                  <div class="rd-item rd-full"><span class="rd-label">交易ID</span><span class="rd-value rd-mono">{{ row.source_trade_id || '—' }}</span></div>
                  <div class="rd-item rd-full"><span class="rd-label">就诊地点</span><span class="rd-value">{{ row.clinic_place || '—' }}</span></div>
                  <div class="rd-item rd-full"><span class="rd-label">创建时间</span><span class="rd-value">{{ row.created_at || '—' }}</span></div>
                </div>
                <div v-if="isCancellable(row)" style="margin-top:10px;text-align:right">
                  <el-button
                    size="small" type="danger" plain
                    :loading="cancellingTradeId === row.source_trade_id"
                    @click.stop="handleCancelRegistration(row)"
                  >取消挂号</el-button>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="patient_name" label="就诊人" width="72" />
          <el-table-column prop="doctor_name" label="医生" width="90" />
          <el-table-column prop="dept_name" label="科室" width="76" show-overflow-tooltip />
          <el-table-column prop="reg_date" label="就诊日期" width="96" />
          <el-table-column prop="visit_time" label="时段" min-width="100" show-overflow-tooltip />
          <el-table-column label="费用" width="64">
            <template #default="{ row }">{{ row.order_fee ? `¥${row.order_fee}` : '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="recordStatusType(row)" size="small" disable-transitions>
                {{ row.source_status_name || '待确认' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div v-if="opMessages.length > 0" style="margin-top:14px">
        <div style="font-weight:600;margin-bottom:6px;font-size:14px">消息列表（{{ opMessages.length }} 条）</div>
        <el-table :data="opMessages" size="small" max-height="280" border stripe>
          <el-table-column prop="title" label="标题" min-width="140" />
          <el-table-column prop="effect_time" label="时间" width="150" />
          <el-table-column label="已读" width="56">
            <template #default="{ row }">{{ row.read_or_not ? '是' : '否' }}</template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="opLogDialog = false" :disabled="!!opRunning">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 请求记录弹窗 -->
    <el-dialog
      v-model="reqLogDialog"
      title="请求记录"
      width="860px"
      :close-on-click-modal="true"
    >
      <div v-if="reqLogLoading" style="text-align:center;padding:24px 0;color:#909399">加载中…</div>
      <template v-else>
        <div v-if="reqLogs.length === 0" style="text-align:center;padding:24px 0;color:#c0c4cc">暂无请求记录</div>
        <el-table
          v-else
          ref="reqLogTableRef"
          :data="reqLogs"
          size="small"
          max-height="520"
          border
          row-key="id"
          :expand-row-keys="expandedReqLogKeys"
          @row-click="toggleReqLogExpand"
          style="cursor:pointer"
        >
          <el-table-column type="expand" width="1">
            <template #default="{ row }">
              <div class="reqlog-detail-expand">
                <div v-if="row.request_headers" class="reqlog-section">
                  <div class="reqlog-section-title">请求头</div>
                  <pre class="reqlog-pre">{{ formatJsonStr(row.request_headers) }}</pre>
                </div>
                <div class="reqlog-section" :style="row.request_headers ? 'margin-top:10px' : ''">
                  <div class="reqlog-section-title">请求参数</div>
                  <pre class="reqlog-pre">{{ formatJsonStr(row.request_body_plain) }}</pre>
                </div>
                <div v-if="row.response_headers" class="reqlog-section" style="margin-top:10px">
                  <div class="reqlog-section-title">响应头</div>
                  <pre class="reqlog-pre">{{ formatJsonStr(row.response_headers) }}</pre>
                </div>
                <div class="reqlog-section" style="margin-top:10px">
                  <div class="reqlog-section-title">响应数据</div>
                  <pre class="reqlog-pre">{{ formatJsonStr(row.response_data_plain) }}</pre>
                </div>
                <div v-if="row.error_message" class="reqlog-section" style="margin-top:10px">
                  <div class="reqlog-section-title" style="color:#f56c6c">错误信息</div>
                  <pre class="reqlog-pre reqlog-pre-error">{{ row.error_message }}</pre>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="接口" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ extractApiName(row.request_url) }}</template>
          </el-table-column>
          <el-table-column label="耗时" width="72">
            <template #default="{ row }">{{ row.duration_ms != null ? row.duration_ms + 'ms' : '—' }}</template>
          </el-table-column>
          <el-table-column label="结果" width="68">
            <template #default="{ row }">
              <el-tag :type="row.is_success ? 'success' : 'danger'" size="small" disable-transitions>
                {{ row.is_success ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="代理" width="160" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.proxy_host && row.proxy_port ? `${row.proxy_host}:${row.proxy_port}` : '—' }}
            </template>
          </el-table-column>
          <el-table-column prop="request_time" label="时间" width="160" />
        </el-table>
      </template>
      <template #footer>
        <span style="font-size:12px;color:#909399;margin-right:auto">共 {{ reqLogs.length }} 条</span>
        <el-button @click="reqLogDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 添加患者弹窗 -->
    <el-dialog v-model="addPatientDialog" title="添加患者" width="420px" :append-to-body="true">
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding:8px 10px;background:#f5f7fa;border-radius:6px;border:1px solid #e4e7ed">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:13px;color:#606266;flex-shrink:0;width:48px">年龄</span>
          <el-input-number v-model="autoGenMinAge" :min="1" :max="99" :controls="false" size="small" style="width:60px" />
          <span style="color:#909399;font-size:13px">—</span>
          <el-input-number v-model="autoGenMaxAge" :min="1" :max="99" :controls="false" size="small" style="width:60px" />
          <span style="color:#909399;font-size:12px">岁</span>
          <el-button size="small" type="primary" plain :loading="autoGenLoading" @click="doAutoGenerate" style="margin-left:auto">自动生成</el-button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:13px;color:#606266;flex-shrink:0;width:48px">性别</span>
          <el-radio-group v-model="autoGenGender" size="small">
            <el-radio-button value="">随机</el-radio-button>
            <el-radio-button value="male">男</el-radio-button>
            <el-radio-button value="female">女</el-radio-button>
          </el-radio-group>
        </div>
      </div>
      <el-form :model="patientForm" label-width="80px" size="default">
        <el-form-item label="姓名">
          <el-input v-model="patientForm.name" placeholder="患者真实姓名" />
        </el-form-item>
        <el-form-item label="身份证号">
          <el-input v-model="patientForm.idNo" placeholder="18位身份证号" maxlength="18" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addPatientDialog = false">取消</el-button>
        <el-button type="primary" @click="doAddPatient">确认添加</el-button>
      </template>
    </el-dialog>

    <!-- 添加账号弹窗 -->
    <el-dialog v-model="generateDialog" title="添加账号" width="420px" :append-to-body="true">
      <el-tabs v-model="generateForm.accountType" type="border-card">
        <el-tab-pane label="微信端" name="wechat">
          <el-form :model="generateForm" label-width="80px" size="default" style="margin-top:8px">
            <el-form-item label="生成数量">
              <el-input-number
                v-model="generateForm.count"
                :min="1" :max="200" :step="10"
                controls-position="right"
                style="width:140px"
              />
            </el-form-item>
          </el-form>
          <p style="color:#909399;font-size:12px;margin:4px 0 0">
            随机生成微信端账号（虚拟手机号 + openId），直接写入本地数据库。
          </p>
        </el-tab-pane>
        <el-tab-pane label="App端" name="app">
          <div style="margin-top:8px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <el-radio-group v-model="manualForm.platform" size="small">
                <el-radio-button value="ios">iOS</el-radio-button>
                <el-radio-button value="android">Android</el-radio-button>
              </el-radio-group>
              <el-switch v-model="manualBatchMode" active-text="批量" inactive-text="单个" />
            </div>
            <el-form v-if="!manualBatchMode" :model="manualForm" label-width="70px" size="default">
              <el-form-item label="手机号">
                <el-input v-model="manualForm.mobile" placeholder="11位手机号" maxlength="11" />
              </el-form-item>
              <el-form-item label="密码">
                <el-input v-model="manualForm.password" type="password" placeholder="至少6位密码" show-password />
              </el-form-item>
            </el-form>
            <div v-else>
              <p style="color:#909399;font-size:12px;margin:0 0 6px">
                每行一个账号，格式：<code>手机号 密码</code>（空格或逗号分隔）
              </p>
              <el-input
                v-model="manualBatchText"
                type="textarea"
                :rows="8"
                placeholder="13800138001 abc123456&#10;13800138002 abc123456"
              />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="generateDialog = false">取消</el-button>
        <el-button v-if="generateForm.accountType === 'wechat'"
          type="primary" :loading="generateSaving" @click="doGenerate">开始生成
        </el-button>
        <el-button v-else
          type="primary" :loading="manualSaving" @click="doManualAdd">添加账号
        </el-button>
      </template>
    </el-dialog>

    <!-- 批量注册账号弹窗 -->
    <el-dialog v-model="batchRegisterDialog" title="批量注册账号" width="900px" :append-to-body="true"
      :close-on-click-modal="false" @closed="onBatchRegisterClosed">
      <div class="batch-reg-list">
        <div v-for="(row, idx) in regRows" :key="row.uid" class="batch-reg-row"
          :class="{ 'is-done': row.status === 'done' }">
          <el-select v-model="row.platform" size="small" style="width:80px"
            :disabled="row.status === 'done' || row.busy != null"
            @change="onPlatformChange(row)">
            <el-option value="ios" label="iOS" />
            <el-option value="android" label="Android" />
          </el-select>
          <el-input v-model="row.mobile" placeholder="手机号" maxlength="11" size="small"
            style="width:108px" :disabled="row.status === 'done'" />
          <img v-if="row.captchaImg" :src="`data:image/png;base64,${row.captchaImg}`"
            class="reg-captcha-img" title="点击刷新" @click="loadRowCaptcha(row)" />
          <span v-else class="reg-captcha-img placeholder" @click="loadRowCaptcha(row)" title="点击获取">
            <el-icon v-if="row.busy === 'captcha'" class="is-loading"><Loading /></el-icon>
            <span v-else>验证码</span>
          </span>
          <el-input v-model="row.picCode" placeholder="图形码" maxlength="10" size="small"
            style="width:62px" :disabled="!row.captchaImg || row.status === 'done'" />
          <el-input v-model="row.smsCode" placeholder="短信码" maxlength="10" size="small"
            style="width:62px" :disabled="row.status === 'done'" />
          <el-input v-model="row.password" type="password" placeholder="密码≥6" size="small"
            style="width:84px" :disabled="row.status === 'done'" />
          <el-input v-model="row.remark" placeholder="备注" maxlength="200" size="small"
            style="width:90px" :disabled="row.status === 'done'" />
          <el-button size="small" type="primary" plain :loading="row.busy === 'send'"
            :disabled="!canSendRow(row)" @click="doSendRow(row)">发送</el-button>
          <el-button size="small" type="primary" :loading="row.busy === 'submit'"
            :disabled="!canSubmitRow(row)" @click="doSubmitRow(row)">注册</el-button>
          <el-tooltip v-if="row.errMsg" :content="row.errMsg" placement="top">
            <span class="reg-row-tag err">!</span>
          </el-tooltip>
          <span v-else-if="row.status === 'done'" class="reg-row-tag done" title="已注册">✓</span>
          <span v-else class="reg-row-del" @click="removeRow(idx)" title="删除此行">×</span>
        </div>
      </div>
      <div style="margin-top:10px">
        <el-button size="small" plain @click="addRow">+ 添加行</el-button>
      </div>
      <template #footer>
        <el-button @click="batchRegisterDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 批量操作进度弹窗 -->
    <el-dialog
      v-model="batchProgressDialog"
      :title="`批量操作：${batchProgressOp}`"
      width="560px"
      :close-on-click-modal="!batchRunning"
      :close-on-press-escape="!batchRunning"
      :append-to-body="true"
    >
      <div v-if="batchRunning" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:#606266">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>正在执行，请稍候…</span>
      </div>
      <el-table :data="batchProgressItems" size="small" max-height="360" border>
        <el-table-column prop="mobile" label="手机号" width="130" />
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'pending'" type="info" size="small">等待</el-tag>
            <el-tag v-else-if="row.status === 'running'" type="warning" size="small">执行中</el-tag>
            <el-tag v-else-if="row.status === 'done'" type="success" size="small">完成</el-tag>
            <el-tag v-else type="danger" size="small">失败</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="msg" label="结果" min-width="120" show-overflow-tooltip />
      </el-table>
      <template #footer>
        <el-button :disabled="batchRunning" @click="batchProgressDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 操作代理分配弹窗 -->
    <el-dialog v-model="opsProxyDialog" title="分配操作代理" width="400px" :append-to-body="true">
      <p style="color:#909399;font-size:12px;margin:0 0 12px">
        账号：<b>{{ opsProxyTarget?.mobile }}</b><br>
        操作代理为账号级共享代理，用于登录、获取消息等非任务操作。选择"不使用"则清除设置。
      </p>
      <el-select v-model="opsProxySelected" placeholder="不使用操作代理" clearable style="width:100%"
        v-loading="opsProxyLoading" filterable>
        <el-option
          v-for="p in opsProxiesUsable"
          :key="p.id"
          :value="p.id"
          :label="p.proxy_type === 'direct' ? '本机直连' : `${p.host}:${p.port}`"
        >
          <span class="mono">{{ p.proxy_type === 'direct' ? '本机直连' : `${p.host}:${p.port}` }}</span>
          <span v-if="p.group_name" style="color:#909399;font-size:12px;margin-left:8px">{{ p.group_name }}</span>
        </el-option>
      </el-select>
      <template #footer>
        <el-button @click="opsProxyDialog = false">取消</el-button>
        <el-button type="primary" :loading="opsProxySaving" @click="saveOpsProxy">保存</el-button>
      </template>
    </el-dialog>

    <!-- 代理配置弹窗（与代理模板编辑器一致的 3-Tab 结构） -->
    <el-dialog v-model="proxyOverrideDialog" title="代理配置" width="720px" :append-to-body="true">
      <p style="color:#909399;font-size:12px;margin:0 0 12px">
        代理：<template v-if="proxyOverrideTarget?.proxy?.proxy_type === 'direct'">[直连] {{ proxyOverrideTarget?.proxy?.realProxyIp || '—' }}</template>
        <template v-else>{{ proxyOverrideTarget?.proxy?.realProxyIp || proxyOverrideTarget?.proxy?.host }}:{{ proxyOverrideTarget?.proxy?.port }}</template>
        <br>各字段为该代理的覆盖值；空/null 表示沿用代理模板/系统默认。
      </p>
      <el-form v-loading="proxyOverrideLoading" :model="proxyOverrideForm" label-width="160px" size="small">
        <el-tabs type="border-card">
          <!-- ════════════════════════ 通道配置 ════════════════════════ -->
          <el-tab-pane label="通道配置">
            <el-form-item label="通道开始时间">
              <TimeInput v-model="proxyOverrideForm.startTime" />
              <span class="proxy-cfg-hint">应早于查票开始时间</span>
            </el-form-item>
            <el-form-item label="创建窗口(ms)">
              <el-input-number v-model="proxyOverrideForm.windowTime" :min="1000" :step="1000" controls-position="right" style="width:150px" />
              <span class="proxy-cfg-hint">{{ msToSec(proxyOverrideForm.windowTime) }}</span>
            </el-form-item>
            <el-form-item label="每代理尝试次数">
              <el-input-number v-model="proxyOverrideForm.attempts" :min="1" :max="1000" controls-position="right" style="width:150px" />
            </el-form-item>
            <el-form-item label="时间分布">
              <el-radio-group v-model="proxyOverrideForm.distribution">
                <el-radio value="uniform">均匀</el-radio>
                <el-radio value="random">随机</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="最大成功通道数">
              <el-input-number v-model="proxyOverrideForm.maxSuccessChannels" :min="0" :step="1" controls-position="right" style="width:150px" />
              <span class="proxy-cfg-hint">0 = 不限</span>
            </el-form-item>
            <el-divider>早停策略</el-divider>
            <el-form-item label="启用早停">
              <el-switch v-model="proxyOverrideForm.esEnabled" />
            </el-form-item>
            <template v-if="proxyOverrideForm.esEnabled">
              <el-form-item label="算法">
                <el-radio-group v-model="proxyOverrideForm.esAlgorithm">
                  <el-radio value="dynamic">动态（推荐）</el-radio>
                  <el-radio value="fixed">固定阈值</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="proxyOverrideForm.esAlgorithm === 'dynamic'" label="动态倍数">
                <el-input-number v-model="proxyOverrideForm.esMultiplier" :min="1" :step="1" controls-position="right" style="width:150px" />
              </el-form-item>
              <el-form-item v-else label="固定阈值(ms)">
                <el-input-number v-model="proxyOverrideForm.esFixedThreshold" :min="1000" :step="1000" controls-position="right" style="width:150px" />
              </el-form-item>
            </template>
            <el-divider>自动关闭多余通道</el-divider>
            <el-form-item label="启用">
              <el-switch v-model="proxyOverrideForm.aceEnabled" />
            </el-form-item>
            <template v-if="proxyOverrideForm.aceEnabled">
              <el-form-item label="最大通道数">
                <el-input v-model="proxyOverrideForm.aceMaxChannels" placeholder="auto" style="width:120px" />
                <span class="proxy-cfg-hint">auto = 按查票参数自动计算</span>
              </el-form-item>
              <el-form-item label="监控间隔(ms)">
                <el-input-number v-model="proxyOverrideForm.aceMonitorInterval" :min="0" :step="1000" controls-position="right" style="width:150px" />
              </el-form-item>
            </template>
            <el-divider>目标主机</el-divider>
            <el-form-item label=" " label-width="0">
              <div style="width:100%">
                <p style="color:#909399;font-size:12px;margin:0 0 8px">全不选 = 继承系统配置</p>
                <TargetHostsEditor v-model="proxyOverrideForm.target_hosts" :systemHosts="systemHosts" />
              </div>
            </el-form-item>
          </el-tab-pane>

          <!-- ════════════════════════ 查号配置 ════════════════════════ -->
          <el-tab-pane label="查号配置">
            <el-form-item label="查票开始时间">
              <TimeInput v-model="proxyOverrideForm.check_start_time" />
            </el-form-item>
            <el-form-item label="查票窗口(ms)">
              <el-input-number v-model="proxyOverrideForm.check_window_time" :min="1000" :step="1000" controls-position="right" style="width:150px" />
              <span class="proxy-cfg-hint">{{ msToSec(proxyOverrideForm.check_window_time) }}</span>
            </el-form-item>
            <el-form-item label="最小间隔(ms)">
              <el-input-number v-model="proxyOverrideForm.check_min_interval" :min="50" :step="50" controls-position="right" style="width:150px" />
            </el-form-item>
            <el-form-item label="时间分布">
              <el-radio-group v-model="proxyOverrideForm.check_distribution">
                <el-radio value="uniform">均匀</el-radio>
                <el-radio value="random">随机</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="查到几次后停止">
              <el-input-number v-model="proxyOverrideForm.check_stop_after_found_count" :min="0" :step="1" controls-position="right" style="width:120px" />
              <span class="proxy-cfg-hint">0=永不停止；建议 3</span>
            </el-form-item>
            <el-divider>查票模式</el-divider>
            <el-form-item label="查票模式">
              <el-radio-group v-model="proxyOverrideForm.check_mode">
                <el-radio value="doctor">按医生查票</el-radio>
                <el-radio value="dept">按科室查票</el-radio>
              </el-radio-group>
            </el-form-item>
            <template v-if="proxyOverrideForm.check_mode === 'doctor'">
              <el-form-item label="医生来源">
                <el-radio-group v-model="proxyOverrideForm.doctor_source">
                  <el-radio value="config">配置固定医生</el-radio>
                  <el-radio value="dynamic">动态获取</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="proxyOverrideForm.doctor_source === 'config'" label="医生代码">
                <div>
                  <el-tag
                    v-for="(code, i) in proxyOverrideForm.doctor_codes"
                    :key="i"
                    closable
                    @close="proxyOverrideForm.doctor_codes.splice(i, 1)"
                    style="margin:2px 4px 2px 0"
                  >{{ code }}</el-tag>
                  <el-input
                    v-model="proxyOverrideNewDoctorCode"
                    placeholder="输入代码回车添加"
                    size="small"
                    style="width:160px;margin-top:4px"
                    @keyup.enter="addProxyOverrideDoctorCode"
                  >
                    <template #append><el-button @click="addProxyOverrideDoctorCode">添加</el-button></template>
                  </el-input>
                </div>
              </el-form-item>
              <el-form-item label="选取方式">
                <el-radio-group v-model="proxyOverrideForm.doctor_select_mode">
                  <el-radio value="random">随机</el-radio>
                  <el-radio value="sequential">顺序</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="排班开始日期">
                <el-date-picker v-model="proxyOverrideForm.doctor_plan_date_start" type="date" value-format="YYYY-MM-DD" placeholder="留空=不限" clearable />
              </el-form-item>
            </template>
            <template v-else-if="proxyOverrideForm.check_mode === 'dept'">
              <el-form-item label="科室代码">
                <el-input v-model="proxyOverrideForm.dept_code" placeholder="输入科室代码" style="width:200px" />
              </el-form-item>
              <el-form-item label="排班开始日期">
                <el-date-picker v-model="proxyOverrideForm.dept_plan_date_start" type="date" value-format="YYYY-MM-DD" placeholder="留空=不限" clearable />
              </el-form-item>
              <el-form-item label="排班结束日期">
                <el-date-picker v-model="proxyOverrideForm.dept_plan_date_end" type="date" value-format="YYYY-MM-DD" placeholder="留空=不限" clearable />
              </el-form-item>
            </template>
            <el-divider>通道复用</el-divider>
            <el-form-item label="启用复用">
              <el-switch v-model="proxyOverrideForm.reuseEnabled" />
            </el-form-item>
            <template v-if="proxyOverrideForm.reuseEnabled">
              <el-form-item label="最小复用间隔(ms)">
                <el-input-number v-model="proxyOverrideForm.reuseMinInterval" :min="0" :step="100" controls-position="right" style="width:150px" />
              </el-form-item>
              <el-form-item label="超时后复用">
                <el-switch v-model="proxyOverrideForm.reuseOnTimeout" />
              </el-form-item>
              <el-form-item label="报错后复用">
                <el-switch v-model="proxyOverrideForm.reuseOnError" />
              </el-form-item>
            </template>
          </el-tab-pane>

          <!-- ════════════════════════ 锁号配置 ════════════════════════ -->
          <el-tab-pane label="锁号配置">
            <el-form-item label="预留通道数">
              <el-input-number v-model="proxyOverrideForm.lock_reserved_channels" :min="0" :step="1" controls-position="right" style="width:120px" />
            </el-form-item>
            <el-form-item label="锁号开始时间">
              <div>
                <el-radio-group v-model="proxyOverrideLockMode">
                  <el-radio value="immediate">查到票立即开始</el-radio>
                  <el-radio value="scheduled">指定时间</el-radio>
                </el-radio-group>
                <div v-if="proxyOverrideLockMode === 'scheduled'" style="margin-top:8px;display:flex;align-items:center;gap:8px">
                  <TimeInput v-model="proxyOverrideForm.lock_start_time" />
                </div>
              </div>
            </el-form-item>
            <el-form-item label="首次锁号延迟(ms)">
              <el-input-number v-model="proxyOverrideForm.lock_first_delay_ms" :min="0" :step="100" controls-position="right" style="width:150px" />
            </el-form-item>
            <el-form-item label="锁号窗口(ms)">
              <el-input-number v-model="proxyOverrideForm.lock_window_time" :min="1000" :step="1000" controls-position="right" style="width:150px" />
              <span class="proxy-cfg-hint">{{ msToSec(proxyOverrideForm.lock_window_time) }}</span>
            </el-form-item>
            <el-form-item label="最小锁号间隔(ms)">
              <el-input-number v-model="proxyOverrideForm.lock_min_interval" :min="0" :step="50" controls-position="right" style="width:150px" />
            </el-form-item>
            <el-form-item label="无通道时直连">
              <el-switch v-model="proxyOverrideForm.lock_direct_on_no_channel" />
            </el-form-item>
            <el-form-item label="SubmitSign 策略">
              <el-select v-model="proxyOverrideForm.submit_sign_strategy" style="width:200px">
                <el-option value="first"  label="使用最先获取的" />
                <el-option value="latest" label="使用最新获取的" />
                <el-option value="rotate" label="轮换使用（推荐）" />
              </el-select>
            </el-form-item>
          </el-tab-pane>

          <!-- ════════════════════════ 心跳保活 ════════════════════════ -->
          <el-tab-pane label="心跳保活">
            <el-form-item label="启用心跳">
              <el-switch v-model="proxyOverrideForm.keepalive_enabled" :active-value="1" :inactive-value="0" />
            </el-form-item>
            <template v-if="proxyOverrideForm.keepalive_enabled">
              <el-form-item label="心跳超时(ms)">
                <el-input-number v-model="proxyOverrideForm.heartbeat_timeout" :min="1000" :step="1000" controls-position="right" style="width:150px" />
                <span class="proxy-cfg-hint">{{ msToSec(proxyOverrideForm.heartbeat_timeout) }}</span>
              </el-form-item>
              <el-form-item label="心跳间隔范围(ms)">
                <el-input-number v-model="proxyOverrideForm.keepalive_interval_min" :min="1000" :step="1000" controls-position="right" style="width:140px" />
                <span style="margin:0 8px;color:#909399">~</span>
                <el-input-number v-model="proxyOverrideForm.keepalive_interval_max" :min="1000" :step="1000" controls-position="right" style="width:140px" />
              </el-form-item>
              <el-form-item label="心跳类型">
                <el-radio-group v-model="proxyOverrideForm.keepalive_request_type">
                  <el-radio value="head">HEAD（轻量）</el-radio>
                  <el-radio value="systemConfig">模拟业务（随机抽端点）</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item v-if="proxyOverrideForm.keepalive_request_type === 'systemConfig'" label="启用的业务端点">
                <div style="width:100%">
                  <div style="color:#909399;font-size:12px;margin-bottom:6px">勾选的 endpoint 进入抽样池；每次心跳随机选 1 条。空 = 全启用。</div>
                  <div style="display:flex;flex-wrap:wrap;gap:4px 16px">
                    <el-checkbox
                      v-for="ep in heartbeatEndpoints"
                      :key="ep.id"
                      :model-value="proxyOverrideForm.keepalive_business_endpoints.includes(ep.id)"
                      @update:model-value="toggleProxyEndpoint(ep.id, $event)"
                    >
                      <span style="font-size:13px">{{ ep.name }}</span>
                      <span style="color:#909399;font-size:11px;margin-left:4px">{{ ep.path }}</span>
                    </el-checkbox>
                  </div>
                  <div style="color:#909399;font-size:12px;margin-top:6px">
                    当前启用 {{ proxyOverrideForm.keepalive_business_endpoints.length }} / {{ heartbeatEndpoints.length }} 条
                    <el-button link type="primary" size="small" @click="toggleAllProxyEndpoints(true)">全选</el-button>
                    <el-button link size="small" @click="toggleAllProxyEndpoints(false)">清空</el-button>
                  </div>
                </div>
              </el-form-item>
              <el-form-item label="启用直连TCP保活">
                <el-switch v-model="proxyOverrideForm.direct_keepalive_enabled" :active-value="1" :inactive-value="0" />
                <span class="proxy-cfg-hint">仅对直连模式生效</span>
              </el-form-item>
            </template>
          </el-tab-pane>

          <el-tab-pane label="TLS指纹">
            <el-form-item label="TLS 指纹">
              <el-select v-model="proxyOverrideForm.fingerprint_name" style="width:300px">
                <el-option
                  v-for="fp in fingerprints"
                  :key="fp.name"
                  :value="fp.name"
                  :label="fp.label + (fp.isDefault ? '（默认）' : '')"
                />
              </el-select>
            </el-form-item>
            <el-form-item v-if="proxyOverrideSelectedFp" label=" " label-width="0">
              <div style="width:100%;color:#606266;font-size:12px;line-height:1.9">
                <div>来源：{{ proxyOverrideSelectedFp.source || '—' }}</div>
                <div>模式：{{ proxyOverrideSelectedFp.mode }} ｜ ALPN：{{ (proxyOverrideSelectedFp.alpn || []).join(', ') || '—' }}</div>
                <div style="font-family:monospace">JA3：{{ proxyOverrideSelectedFp.ja3 || '（每连随机/见 JA4）' }}</div>
                <div style="font-family:monospace">JA4：{{ proxyOverrideSelectedFp.ja4 || '—' }}</div>
                <div style="color:#909399;margin-top:8px">需运行 fp-sidecar 并设 FP_SIDECAR_ADDR 才生效；否则走原生 TLS。</div>
              </div>
            </el-form-item>
          </el-tab-pane>
        </el-tabs>
      </el-form>
      <template #footer>
        <el-button @click="proxyOverrideDialog = false">取消</el-button>
        <el-button type="primary" :loading="proxyOverrideSaving" @click="saveProxyOverride">保存</el-button>
      </template>
    </el-dialog>
  </MainLayout>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { Plus, User, Loading, Delete } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import MainLayout from '@/layout/MainLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import TaskConfigDialog from '@/components/TaskConfigDialog.vue'
import TargetHostsEditor from '@/components/TargetHostsEditor.vue'
import TimeInput from '@/components/TimeInput.vue'
import {
  getAccounts, setAccountEnabled, updateAccount, deleteAccount,
  getTasks, createTask, deleteTask, startTask, stopTask, getRunningTasks,
  getDoctors, getAccountPatients, getTaskProxies, getTaskProxyStats,
  updateProxyConfig,
  getProxyTemplates, getSystemConfig, getHeartbeatEndpoints, getFingerprints,
  executeAccountOperation, getAccountSourceRecords, getAccountMessages, getAccountRequestLogs,
  generateAccounts, addManualAccount,
  generatePatientInfo,
  autoAssignProxies, autoAssignOpsAll, setAccountOpsProxy, getProxies,
  createRegisterSession, getRegisterCaptcha, sendRegisterSms, submitRegister, cancelRegisterSession,
} from '@/api'
import { useWebSocket } from '@/composables/useWebSocket'
import { isTimeString } from '@/utils/validate'

const { subscribe } = useWebSocket()

// ── 基础状态 ──
const loading       = ref(false)
const accounts      = ref([])
const allTasks      = ref([])
const patientsMap   = ref({})
const runtimeStatus = reactive({})
const filterMobile  = ref('')
const filterEnabled = ref('')
const filterRisk    = ref('')
const filterBanned  = ref('')
const tasksLoading  = ref(false)

// ── 展开状态 ──
const expandedIds   = ref(new Set())

// ── 任务配置弹窗 ──
const configDialogVisible = ref(false)
const configTaskId        = ref(null)

// ── 代理明细 & 实时统计 ──
const taskProxiesMap = reactive({})
const taskLiveStats  = reactive({})
const statsPollers   = {}

// ── 系统配置 ──
const systemHosts = ref([])
const defaultProxyMaxCount = ref(10)

// ── 代理覆盖配置对话框 ──
const proxyOverrideDialog   = ref(false)
const proxyOverrideTarget   = ref(null)
// 跟代理模板严格一致：去掉"继承"语义，每个字段都有具体默认值
const proxyOverrideForm     = reactive({
  // ── 通道配置 ───────────────────────────────────────────────────────
  startTime: '',
  windowTime: 270000,
  attempts: 200,
  distribution: 'uniform',
  maxSuccessChannels: 0,
  target_hosts: [],
  // 早停
  esEnabled: true,
  esAlgorithm: 'dynamic',
  esMultiplier: 15,
  esFixedThreshold: 20000,
  // 自动关闭多余通道
  aceEnabled: true,
  aceMaxChannels: 'auto',
  aceMonitorInterval: 0,

  // ── 查号配置 ───────────────────────────────────────────────────────
  check_mode: 'doctor',
  check_start_time: '',
  check_window_time: 10000,
  check_min_interval: 250,
  check_distribution: 'uniform',
  check_stop_after_found_count: 3,
  // 按医生子树
  doctor_source: 'config',
  doctor_select_mode: 'random',
  doctor_codes: [],
  doctor_plan_date_start: null,
  // 按科室子树
  dept_code: '',
  dept_plan_date_start: null,
  dept_plan_date_end: null,
  // 通道复用
  reuseEnabled: false,
  reuseMinInterval: 1000,
  reuseOnTimeout: false,
  reuseOnError: false,

  // ── 锁号配置 ───────────────────────────────────────────────────────
  lock_reserved_channels: 0,
  lock_start_time: '',
  lock_first_delay_ms: 0,
  lock_window_time: 20000,
  lock_min_interval: 250,
  lock_direct_on_no_channel: false,
  submit_sign_strategy: 'rotate',

  // ── 心跳保活 ───────────────────────────────────────────────────────
  keepalive_enabled: 1,
  keepalive_interval_min: 40000,
  keepalive_interval_max: 70000,
  keepalive_request_type: 'head',
  keepalive_business_endpoints: [],
  direct_keepalive_enabled: 0,
  heartbeat_timeout: 300000,

  // ── TLS 指纹 ───────────────────────────────────────────────────────
  fingerprint_name: 'android_app',
})
// 锁号开始时间的 radio 形态：'immediate' / 'scheduled'
const proxyOverrideLockMode = ref('immediate')
// 临时输入：医生代码添加框
const proxyOverrideNewDoctorCode = ref('')
const proxyOverrideSaving   = ref(false)
const proxyOverrideLoading  = ref(false)
// 心跳业务端点元数据（onMounted 拉取）
const heartbeatEndpoints = ref([])
// TLS 指纹注册表（首次打开代理覆盖弹窗时拉取）
const fingerprints = ref([])
const proxyOverrideSelectedFp = computed(() => fingerprints.value.find(f => f.name === proxyOverrideForm.fingerprint_name) || null)
function toggleProxyEndpoint(id, checked) {
  const set = new Set(proxyOverrideForm.keepalive_business_endpoints)
  if (checked) set.add(id); else set.delete(id)
  proxyOverrideForm.keepalive_business_endpoints = Array.from(set)
}
function toggleAllProxyEndpoints(all) {
  proxyOverrideForm.keepalive_business_endpoints = all ? heartbeatEndpoints.value.map(e => e.id) : []
}

// ── 新建任务对话框 ──
const taskDialog        = ref(false)
const taskSaving        = ref(false)
const taskTargetAccount = ref(null)
const taskForm    = reactive({ doctor_code: null, lock_plan_date: '', patient_id: null, proxy_template_ids: [] })
const patients    = ref([])
const patientsLoading = ref(false)
const doctors     = ref([])
const templates   = ref([])
const doctorQuery = ref('')

// ── 计算属性 ──
const filtered = computed(() =>
  accounts.value.filter(a => {
    if (filterMobile.value && !a.mobile.includes(filterMobile.value)) return false
    if (filterEnabled.value !== '' && String(a.enabled) !== filterEnabled.value) return false
    if (filterRisk.value !== '' && String(a.is_risk_flagged ? '1' : '0') !== filterRisk.value) return false
    if (filterBanned.value !== '' && String(a.is_banned ? '1' : '0') !== filterBanned.value) return false
    return true
  })
)

const accountTasksMap = computed(() => {
  const map = {}
  for (const t of allTasks.value) {
    if (t.account_id != null) {
      if (!map[t.account_id]) map[t.account_id] = []
      map[t.account_id].push(t)
    }
  }
  return map
})

const filteredDoctors = computed(() => {
  if (!doctorQuery.value) return doctors.value
  const q = doctorQuery.value.toLowerCase()
  return doctors.value.filter(d =>
    d.doctor_code.toLowerCase().includes(q) || d.doctor_name.toLowerCase().includes(q)
  )
})

// ── 工具函数 ──
function isRunning(taskId) {
  const s = runtimeStatus[taskId]?.status
  return s === 'running' || s === 'initializing'
}

function accountHasRunningTask(accountId) {
  const tasks = accountTasksMap.value[accountId] || []
  return tasks.some(t => isRunning(t.id))
}

async function copyAccountInfo(acct) {
  const parts = [acct.mobile, acct.password, acct.device_uuid].filter(Boolean)
  const text = parts.join(' ')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    ElMessage.success('已复制：' + text)
  } catch (e) {
    ElMessage.error('复制失败：' + (e.message || e))
  }
}

function patientIcon(p) {
  const isAdult = p.age == null || p.age >= 18
  if (isAdult && p.gender === '男') return '👨'
  if (isAdult && p.gender === '女') return '👩'
  if (!isAdult && p.gender === '男') return '👦'
  if (!isAdult && p.gender === '女') return '👧'
  return '🧑'
}

function getPatientName(task) {
  const list = patientsMap.value[task.account_id] || []
  const p = list.find(p => String(p.id) === String(task.patient_id))
  return p ? p.name : '—'
}

function getDoctorDisplay(task) {
  const code = task.doctor_code
  if (!code) return '—'
  const doc = doctors.value.find(d => d.doctor_code === code)
  return doc ? `${doc.doctor_name}（${code}）` : code
}

function toggleExpand(accountId) {
  const s = new Set(expandedIds.value)
  if (s.has(accountId)) {
    s.delete(accountId)
    const tasks = accountTasksMap.value[accountId] || []
    tasks.forEach(t => stopStatsPoller(t.id))
  } else {
    s.add(accountId)
    loadTaskProxiesForAccount(accountId)
  }
  expandedIds.value = s
}

// 把 proxy（含 channel_build_overrides / lock_config / check_reuse_channel / effective 等）映射到 proxyOverrideForm。
// 跟代理模板严格一致：所有字段都落到具体值——优先 proxy 自身覆盖、否则用 effective（合并模板/系统）兜底。
// 不再有"null=继承"语义；保存时所有字段都显式写回 DB。
function fillFormFromProxy(proxy) {
  const cb    = proxy.channel_build_overrides || {}
  const cbES  = cb.earlyStop                  || {}
  const cbACE = cb.autoCloseExcess            || {}
  const lk    = proxy.lock_config             || {}
  const ru    = proxy.check_reuse_channel     || {}
  const eff   = proxy.effective               || {}
  const effCB = eff.channel_build_overrides   || {}
  const effCBES = effCB.earlyStop             || {}
  const effCBACE = effCB.autoCloseExcess      || {}
  const effLK = eff.lock_config               || {}
  const effRU = eff.check_reuse_channel       || {}
  // 取值优先级：cb/lk/ru（自身覆盖） > eff（合并后） > 默认值
  const pickStr = (...vals) => { for (const v of vals) if (v != null && v !== '') return v; return '' }
  const pickNum = (...vals) => { for (const v of vals) if (v != null) return v; return 0 }
  const pickBool = (...vals) => { for (const v of vals) if (v !== undefined) return !!v; return false }

  // ── 通道配置 ──
  proxyOverrideForm.startTime          = pickStr(cb.startTime, effCB.startTime)
  proxyOverrideForm.windowTime         = pickNum(cb.windowTime, effCB.windowTime, 270000)
  proxyOverrideForm.attempts           = pickNum(cb.attempts, effCB.attempts, 200)
  proxyOverrideForm.distribution       = pickStr(cb.distribution, effCB.distribution, 'uniform') || 'uniform'
  proxyOverrideForm.maxSuccessChannels = pickNum(cb.maxSuccessChannels, effCB.maxSuccessChannels, 0)
  proxyOverrideForm.target_hosts       = Array.isArray(proxy.target_hosts) && proxy.target_hosts.length
    ? [...proxy.target_hosts]
    : (Array.isArray(eff.target_hosts) ? [...eff.target_hosts] : [])
  // 早停（二态 switch + 子字段）
  proxyOverrideForm.esEnabled          = pickBool(cbES.enabled, effCBES.enabled, true)
  proxyOverrideForm.esAlgorithm        = pickStr(cbES.algorithm, effCBES.algorithm, 'dynamic') || 'dynamic'
  proxyOverrideForm.esMultiplier       = pickNum(cbES.multiplier, effCBES.multiplier, 15)
  proxyOverrideForm.esFixedThreshold   = pickNum(cbES.fixedThreshold, effCBES.fixedThreshold, 20000)
  // 自动关闭多余通道（二态 switch + 子字段）
  proxyOverrideForm.aceEnabled         = pickBool(cbACE.enabled, effCBACE.enabled, true)
  // maxSuccessChannels 可能是 'auto' 字符串
  proxyOverrideForm.aceMaxChannels     = (cbACE.maxSuccessChannels ?? effCBACE.maxSuccessChannels ?? 'auto')
  proxyOverrideForm.aceMonitorInterval = pickNum(cbACE.monitorInterval, effCBACE.monitorInterval, 0)

  // ── 查号配置 ──
  proxyOverrideForm.check_mode                   = pickStr(proxy.check_mode, eff.check_mode, 'doctor') || 'doctor'
  proxyOverrideForm.check_start_time             = pickStr(proxy.check_start_time, eff.check_start_time)
  proxyOverrideForm.check_window_time            = pickNum(proxy.check_window_time, eff.check_window_time, 10000)
  proxyOverrideForm.check_min_interval           = pickNum(proxy.check_min_interval, eff.check_min_interval, 250)
  proxyOverrideForm.check_distribution           = pickStr(proxy.check_distribution, eff.check_distribution, 'uniform') || 'uniform'
  proxyOverrideForm.check_stop_after_found_count = pickNum(proxy.check_stop_after_found_count, eff.check_stop_after_found_count, 3)
  // 按医生子树
  proxyOverrideForm.doctor_source                = pickStr(proxy.doctor_source, eff.doctor_source, 'config') || 'config'
  proxyOverrideForm.doctor_select_mode           = pickStr(proxy.doctor_select_mode, eff.doctor_select_mode, 'random') || 'random'
  const proxyDoctorCodes = Array.isArray(proxy.doctor_codes) ? proxy.doctor_codes : []
  const effDoctorCodes   = Array.isArray(eff.doctor_codes)   ? eff.doctor_codes   : []
  proxyOverrideForm.doctor_codes                 = proxyDoctorCodes.length ? [...proxyDoctorCodes] : [...effDoctorCodes]
  proxyOverrideForm.doctor_plan_date_start       = proxy.doctor_plan_date_start || eff.doctor_plan_date_start || null
  // 按科室子树
  proxyOverrideForm.dept_code                    = pickStr(proxy.dept_code, eff.dept_code)
  proxyOverrideForm.dept_plan_date_start         = proxy.dept_plan_date_start || eff.dept_plan_date_start || null
  proxyOverrideForm.dept_plan_date_end           = proxy.dept_plan_date_end   || eff.dept_plan_date_end   || null
  // 通道复用（switch + 子字段）
  proxyOverrideForm.reuseEnabled                 = pickBool(ru.enabled, effRU.enabled, false)
  proxyOverrideForm.reuseMinInterval             = pickNum(ru.minInterval, effRU.minInterval, 1000)
  proxyOverrideForm.reuseOnTimeout               = pickBool(ru.reuseOnTimeout, effRU.reuseOnTimeout, false)
  proxyOverrideForm.reuseOnError                 = pickBool(ru.reuseOnError, effRU.reuseOnError, false)

  // ── 锁号配置 ──
  proxyOverrideForm.lock_reserved_channels  = pickNum(lk.reservedChannels, effLK.reservedChannels, 0)
  proxyOverrideForm.lock_start_time         = pickStr(lk.lockStartTime, effLK.lockStartTime)
  proxyOverrideForm.lock_first_delay_ms     = pickNum(lk.firstLockDelayMs, effLK.firstLockDelayMs, 0)
  proxyOverrideForm.lock_window_time        = pickNum(lk.windowTime, effLK.windowTime, 20000)
  proxyOverrideForm.lock_min_interval       = pickNum(lk.minInterval, effLK.minInterval, 250)
  proxyOverrideForm.lock_direct_on_no_channel = pickBool(lk.directRequestOnNoChannel, effLK.directRequestOnNoChannel, false)
  proxyOverrideForm.submit_sign_strategy    = pickStr(lk.submitSignStrategy, effLK.submitSignStrategy, 'rotate') || 'rotate'

  // ── 心跳保活 ──（proxy 覆盖列优先，否则 effective 合并值兜底）
  proxyOverrideForm.keepalive_enabled        = pickNum(proxy.keepalive_enabled, eff.keepalive_enabled, 1)
  proxyOverrideForm.keepalive_interval_min   = pickNum(proxy.keepalive_interval_min, eff.keepalive_interval_min, 40000)
  proxyOverrideForm.keepalive_interval_max   = pickNum(proxy.keepalive_interval_max, eff.keepalive_interval_max, 70000)
  proxyOverrideForm.keepalive_request_type   = pickStr(proxy.keepalive_request_type, eff.keepalive_request_type, 'head') || 'head'
  const proxyEndpoints = Array.isArray(proxy.keepalive_business_endpoints) ? proxy.keepalive_business_endpoints : null
  const effEndpoints   = Array.isArray(eff.keepalive_business_endpoints)   ? eff.keepalive_business_endpoints   : []
  proxyOverrideForm.keepalive_business_endpoints = proxyEndpoints && proxyEndpoints.length ? [...proxyEndpoints] : [...effEndpoints]
  proxyOverrideForm.direct_keepalive_enabled = pickNum(proxy.direct_keepalive_enabled, eff.direct_keepalive_enabled, 0)
  proxyOverrideForm.heartbeat_timeout        = pickNum(proxy.heartbeat_timeout, eff.heartbeat_timeout, 300000)
  // TLS 指纹：代理覆盖 fingerprint_config.name → 有效指纹 name → 默认 android_app
  proxyOverrideForm.fingerprint_name = (proxy.fingerprint_config && proxy.fingerprint_config.name)
    || (eff.fingerprint && eff.fingerprint.name) || 'android_app'

  // 锁号开始时间 radio：有非空字符串=指定，空=立即
  proxyOverrideLockMode.value = proxyOverrideForm.lock_start_time ? 'scheduled' : 'immediate'
  // 临时输入清零
  proxyOverrideNewDoctorCode.value = ''
}

async function openProxyOverride(taskId, proxy) {
  proxyOverrideLoading.value  = true
  // 先用缓存占位让弹窗能展示，再从后端拉一次最新值覆盖，避免 taskProxiesMap 缓存过期
  proxyOverrideTarget.value   = { taskId, proxy }
  try {
    const r = await getTaskProxies(taskId)
    if (Array.isArray(r.data)) {
      taskProxiesMap[taskId] = r.data
      const fresh = r.data.find(p => p.id === proxy.id)
      if (fresh) {
        proxy = fresh
        proxyOverrideTarget.value = { taskId, proxy }
      }
    }
  } catch (_) { /* 离线/超时就退化用缓存 */ }
  if (!fingerprints.value.length) {
    try { const fp = await getFingerprints(); fingerprints.value = Array.isArray(fp.data?.list) ? fp.data.list : [] } catch (_) {}
  }
  fillFormFromProxy(proxy)
  proxyOverrideDialog.value = true
  proxyOverrideLoading.value = false
}

function addProxyOverrideDoctorCode() {
  const code = (proxyOverrideNewDoctorCode.value || '').trim()
  if (!code) return
  if (!proxyOverrideForm.doctor_codes.includes(code)) proxyOverrideForm.doctor_codes.push(code)
  proxyOverrideNewDoctorCode.value = ''
}

async function saveProxyOverride() {
  const { taskId, proxy } = proxyOverrideTarget.value
  // 时间格式校验
  if (proxyOverrideForm.startTime && !isTimeString(proxyOverrideForm.startTime))
    return ElMessage.error('通道开始时间格式不正确，应为 HH:MM:SS')
  if (proxyOverrideForm.check_start_time && !isTimeString(proxyOverrideForm.check_start_time))
    return ElMessage.error('查票开始时间格式不正确')
  // 锁号开始时间：选了"指定"就必须填合法时间
  if (proxyOverrideLockMode.value === 'scheduled') {
    if (!proxyOverrideForm.lock_start_time) return ElMessage.error('已选择指定时间，请填写锁号开始时间')
    if (!isTimeString(proxyOverrideForm.lock_start_time)) return ElMessage.error('锁号开始时间格式不正确')
  }
  // 自动关闭多余通道→最大通道数：'auto' 或正整数
  if (proxyOverrideForm.aceEnabled) {
    const v = proxyOverrideForm.aceMaxChannels
    if (v !== 'auto' && v !== '' && v != null && !(Number.isInteger(Number(v)) && Number(v) > 0)) {
      return ElMessage.error('自动关闭多余通道的最大通道数应为 "auto" 或正整数')
    }
  }
  // 心跳校验
  if (proxyOverrideForm.keepalive_enabled) {
    const mn = proxyOverrideForm.keepalive_interval_min, mx = proxyOverrideForm.keepalive_interval_max
    if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn < 1000 || mx < 1000)
      return ElMessage.error('心跳间隔范围应为 ≥1000 的整数（ms）')
    if (mn > mx) return ElMessage.error('心跳间隔下界不能大于上界')
    if (proxyOverrideForm.keepalive_request_type === 'systemConfig' && proxyOverrideForm.keepalive_business_endpoints.length === 0)
      return ElMessage.error('已选择"模拟业务"心跳类型，但未启用任何业务端点')
  }

  // ── 通道配置（channel_build_overrides JSON）：所有字段都显式写入 ──
  const channelOverrides = {
    startTime:          proxyOverrideForm.startTime || '',
    windowTime:         proxyOverrideForm.windowTime,
    attempts:           proxyOverrideForm.attempts,
    distribution:       proxyOverrideForm.distribution,
    maxSuccessChannels: proxyOverrideForm.maxSuccessChannels,
    earlyStop: {
      enabled:        !!proxyOverrideForm.esEnabled,
      algorithm:      proxyOverrideForm.esAlgorithm || 'dynamic',
      multiplier:     proxyOverrideForm.esMultiplier,
      fixedThreshold: proxyOverrideForm.esFixedThreshold,
    },
    autoCloseExcess: {
      enabled:            !!proxyOverrideForm.aceEnabled,
      maxSuccessChannels: proxyOverrideForm.aceMaxChannels ?? 'auto',
      monitorInterval:    proxyOverrideForm.aceMonitorInterval ?? 0,
    },
    targetHosts: proxyOverrideForm.target_hosts.length ? proxyOverrideForm.target_hosts : null,
  }

  // ── 锁号配置（lock_config JSON）──
  const lockConfig = {
    reservedChannels:         proxyOverrideForm.lock_reserved_channels ?? 0,
    lockStartTime:            proxyOverrideLockMode.value === 'scheduled' ? (proxyOverrideForm.lock_start_time || '') : '',
    firstLockDelayMs:         proxyOverrideForm.lock_first_delay_ms ?? 0,
    windowTime:               proxyOverrideForm.lock_window_time,
    minInterval:              proxyOverrideForm.lock_min_interval,
    directRequestOnNoChannel: !!proxyOverrideForm.lock_direct_on_no_channel,
    submitSignStrategy:       proxyOverrideForm.submit_sign_strategy || 'rotate',
  }

  // ── 通道复用（check_reuse_channel JSON）──
  const reuseConfig = {
    enabled:        !!proxyOverrideForm.reuseEnabled,
    minInterval:    proxyOverrideForm.reuseMinInterval ?? 1000,
    reuseOnTimeout: !!proxyOverrideForm.reuseOnTimeout,
    reuseOnError:   !!proxyOverrideForm.reuseOnError,
  }

  proxyOverrideSaving.value = true
  try {
    await updateProxyConfig(proxy.id, {
      // 通道
      channel_build_overrides:      channelOverrides,
      target_hosts:                 proxyOverrideForm.target_hosts.length ? proxyOverrideForm.target_hosts : null,
      // 查号标量列
      check_mode:                   proxyOverrideForm.check_mode,
      check_start_time:             proxyOverrideForm.check_start_time || null,
      check_window_time:            proxyOverrideForm.check_window_time,
      check_min_interval:           proxyOverrideForm.check_min_interval,
      check_distribution:           proxyOverrideForm.check_distribution,
      check_stop_after_found_count: proxyOverrideForm.check_stop_after_found_count,
      // 通道复用 JSON
      check_reuse_channel:          reuseConfig,
      // 按医生子树
      doctor_source:                proxyOverrideForm.doctor_source,
      doctor_select_mode:           proxyOverrideForm.doctor_select_mode,
      doctor_codes:                 Array.isArray(proxyOverrideForm.doctor_codes) ? [...proxyOverrideForm.doctor_codes] : [],
      doctor_plan_date_start:       proxyOverrideForm.doctor_plan_date_start || null,
      // 按科室子树
      dept_code:                    proxyOverrideForm.dept_code || null,
      dept_plan_date_start:         proxyOverrideForm.dept_plan_date_start || null,
      dept_plan_date_end:           proxyOverrideForm.dept_plan_date_end || null,
      // 锁号
      lock_config:                  lockConfig,
      // 心跳/keepAlive 代理级覆盖
      keepalive_enabled:            proxyOverrideForm.keepalive_enabled,
      keepalive_interval_min:       proxyOverrideForm.keepalive_interval_min,
      keepalive_interval_max:       proxyOverrideForm.keepalive_interval_max,
      keepalive_request_type:       proxyOverrideForm.keepalive_request_type,
      keepalive_business_endpoints: [...proxyOverrideForm.keepalive_business_endpoints],
      direct_keepalive_enabled:     proxyOverrideForm.direct_keepalive_enabled,
      heartbeat_timeout:            proxyOverrideForm.heartbeat_timeout,
      // TLS 指纹（代理级覆盖）
      fingerprint_config:           { name: proxyOverrideForm.fingerprint_name },
    })
    const r = await getTaskProxies(taskId)
    taskProxiesMap[taskId] = r.data
    proxyOverrideDialog.value = false
    ElMessage.success('代理配置已保存')
  } catch (_) {} finally {
    proxyOverrideSaving.value = false
  }
}

// 从 proxy.effective 与 proxy 自身覆盖列对比，给行内 UI 提供 value+override 标志
function getEffectiveCfg(task, proxy) {
  const eff   = proxy.effective || {}
  const cb    = proxy.channel_build_overrides || {}
  const effCB = eff.channel_build_overrides || {}
  const lk    = proxy.lock_config || {}
  const overrideOf = (col) => proxy[col] != null && proxy[col] !== ''
  const cbOver = (key) => cb[key] != null
  const targetHostsValue = (() => {
    const hosts = eff.target_hosts || effCB.targetHosts || null
    if (!hosts || !hosts.length) return null
    return hosts.map(h => {
      const ip = String(h.host || '')
      const seg = ip.split('.').pop()
      return seg ? `.${seg}` : ip
    }).join(' ')
  })()
  return {
    // 通道
    chBuildStart:    { value: effCB.startTime    || '', override: cbOver('startTime') },
    chBuildWindow:   { value: effCB.windowTime,         override: cbOver('windowTime') },
    chBuildAttempts: { value: effCB.attempts,           override: cbOver('attempts') },
    // 查号
    checkMode: {
      value: (eff.check_mode || 'doctor') === 'dept' ? '室' : '医',
      title: (eff.check_mode || 'doctor') === 'dept' ? '按科室查号' : '按医生查号',
    },
    startTime:  { value: eff.check_start_time || '',     override: overrideOf('check_start_time') },
    windowTime: { value: eff.check_window_time,          override: overrideOf('check_window_time') },
    stopAfter:  { value: eff.check_stop_after_found_count ?? 3, override: overrideOf('check_stop_after_found_count') },
    // 锁号
    lockStart:  { value: eff.lock_config?.lockStartTime || '', override: !!(lk.lockStartTime) },
    lockWindow: { value: eff.lock_config?.windowTime,          override: !!(lk.windowTime) },
    sign:       { value: submitSignLabel(eff.lock_config?.submitSignStrategy), override: !!(lk.submitSignStrategy) },
    // 目标主机
    targetHosts:{
      value: targetHostsValue,
      override: !!(proxy.target_hosts && proxy.target_hosts.length),
      title: (eff.target_hosts || effCB.targetHosts || []).map(h => `${h.host}:${h.port}`).join(', '),
    },
  }
}

function fmtStopShort(n) {
  if (n == null) return '—'
  if (n === 0) return '∞'
  return `${n}`
}

function msToDisp(ms) {
  if (ms == null) return '—'
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}分`
  return `${(ms / 1000).toFixed(0)}s`
}

// 与 Templates.vue 中的 msToSec 保持一致，用于代理配置弹窗里 ms 数值的旁注
function msToSec(ms) {
  if (!ms) return ''
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${(ms / 1000).toFixed(1)} 秒`
}

function submitSignLabel(s) {
  if (s === 'first')  return '最先'
  if (s === 'latest') return '最新'
  if (s === 'rotate') return '轮换'
  return '—'
}

function proxyRiskClass(level) {
  if (!level) return ''
  if (level.includes('无')) return 'risk-none'
  if (level.includes('低')) return 'risk-low'
  if (level.includes('高')) return 'risk-high'
  return 'risk-mid'
}

function getLiveProxyStat(taskId, proxy) {
  const stats = taskLiveStats[taskId]
  if (!stats?.length) return null
  const ip = proxy.realProxyIp || proxy.host
  return stats.find(s => (s.realProxyIp || s.host) === ip) || null
}

// 代理行 IP 展示规则：
//   普通代理：<realProxyIp 或 host>:<port>
//   direct：[直连] <realProxyIp>
//   SSH 隧道，正在本地降级（runMode='local'）：127.0.0.1:<port>
//   SSH 隧道，云端运行 / 未运行：<real_ip>（不带端口；按"云端意图"显示）
function formatProxyIp(taskId, p) {
  if (p.proxy_type === 'direct') return `[直连] ${p.realProxyIp || '—'}`
  if (p.proxy_type === 'ssh') {
    const stat = getLiveProxyStat(taskId, p)
    if (stat?.runMode === 'local' && p.port) return `127.0.0.1:${p.port}`
    return p.realProxyIp || '—'
  }
  const ip = p.realProxyIp || p.host
  return p.port ? `${ip}:${p.port}` : (ip || '—')
}

function startStatsPoller(taskId) {
  if (statsPollers[taskId]) return
  statsPollers[taskId] = setInterval(async () => {
    try {
      const r = await getTaskProxyStats(taskId)
      taskLiveStats[taskId] = r.data
    } catch (_) {}
  }, 30000)
}

function stopStatsPoller(taskId) {
  if (statsPollers[taskId]) {
    clearInterval(statsPollers[taskId])
    delete statsPollers[taskId]
  }
}

async function loadTaskProxiesForAccount(accountId) {
  const tasks = accountTasksMap.value[accountId] || []
  for (const task of tasks) {
    try {
      const r = await getTaskProxies(task.id)
      taskProxiesMap[task.id] = r.data
    } catch (_) {}
    if (isRunning(task.id)) startStatsPoller(task.id)
  }
}

function defaultLockDate() {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString().split('T')[0]
}

// ── 数据加载 ──
async function loadAll() {
  loading.value = true
  tasksLoading.value = true
  try {
    const [accts, tasks, running, docs, tmpls, sys, eps] = await Promise.all([
      getAccounts(),
      getTasks(),
      getRunningTasks(),
      getDoctors(),
      getProxyTemplates(),
      getSystemConfig().catch(() => ({ data: {} })),
      getHeartbeatEndpoints().catch(() => ({ data: [] })),
    ])
    accounts.value  = accts.data
    allTasks.value  = tasks.data
    doctors.value   = docs.data  || []
    templates.value = tmpls.data || []
    systemHosts.value = Array.isArray(sys.data?.target_hosts) ? sys.data.target_hosts : []
    heartbeatEndpoints.value = Array.isArray(eps.data) ? eps.data : []
    defaultProxyMaxCount.value = sys.data?.default_proxy_max_count ?? 10
    for (const [id, s] of Object.entries(running.data || {})) {
      runtimeStatus[id] = s
    }
    loadAllPatients()
  } finally {
    loading.value = false
    tasksLoading.value = false
  }
}

async function loadAllPatients() {
  const results = await Promise.allSettled(
    accounts.value.map(a =>
      getAccountPatients(a.id).then(r => ({ id: a.id, patients: r.data || [] }))
    )
  )
  const map = {}
  for (const r of results) {
    if (r.status === 'fulfilled') map[r.value.id] = r.value.patients
  }
  patientsMap.value = map
}

async function reloadTasks() {
  const res = await getTasks()
  allTasks.value = res.data
}

async function reloadAccounts() {
  const res = await getAccounts()
  accounts.value = res.data
}

// ── 账号操作 ──
async function handleDeleteAccount(acct) {
  try {
    await ElMessageBox.confirm(
      `确定删除账号 ${acct.mobile}？\n此操作将同时清除该账号的设备、会话、患者等全部数据，且不可恢复。`,
      '删除账号',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger' }
    )
  } catch (_) { return }
  await deleteAccount(acct.id)
  accounts.value = accounts.value.filter(a => a.id !== acct.id)
  // remove from expandedIds if present
  const s = new Set(expandedIds.value)
  s.delete(acct.id)
  expandedIds.value = s
  ElMessage.success('账号已删除')
}

async function toggleEnabled(acct, v) {
  const res = await setAccountEnabled(acct.id, v)
  const idx = accounts.value.findIndex(a => a.id === acct.id)
  if (idx >= 0) accounts.value[idx] = res.data
  if (v && expandedIds.value.has(acct.id)) loadTaskProxiesForAccount(acct.id)
}

async function updateProxyMax(acct, v) {
  if (!v || v === acct.proxy_max_count) return
  if (accountHasRunningTask(acct.id)) {
    ElMessage.warning('该账号有任务正在运行，请先停止后再调整代理上限')
    return
  }
  await updateAccount(acct.id, { proxy_max_count: v })
  await Promise.all([reloadAccounts(), reloadTasks()])
  if (expandedIds.value.has(acct.id)) loadTaskProxiesForAccount(acct.id)
}

// ── 就诊人操作 ──
const patientTargetAccount = ref(null)
const addPatientDialog     = ref(false)
const patientForm          = reactive({ name: '', idNo: '', sex: '1' })
const autoGenMinAge        = ref(18)
const autoGenMaxAge        = ref(60)
const autoGenGender        = ref('')
const autoGenLoading       = ref(false)

function openAddPatient(acct) {
  patientTargetAccount.value = acct
  Object.assign(patientForm, { name: '', idNo: '', sex: '1' })
  addPatientDialog.value = true
  doAutoGenerate()
}

async function doAutoGenerate() {
  autoGenLoading.value = true
  try {
    const res = await generatePatientInfo(autoGenMinAge.value, autoGenMaxAge.value, autoGenGender.value || undefined)
    const d = res.data
    Object.assign(patientForm, { name: d.name, idNo: d.idNo, sex: d.sex })
  } catch (e) {
    ElMessage.error(e.message || '生成失败')
  } finally {
    autoGenLoading.value = false
  }
}

async function doAddPatient() {
  if (!patientForm.name || !patientForm.idNo) {
    ElMessage.warning('请填写姓名和身份证号')
    return
  }
  addPatientDialog.value = false
  const acct = patientTargetAccount.value
  if (!acct) return
  await handleOp(acct.id, 'add-patient', { ...patientForm })
}

async function quickDeletePatient(acct, p) {
  try {
    await ElMessageBox.confirm(`确定删除就诊人 ${p.name}？`, '删除就诊人', {
      type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消'
    })
  } catch (_) { return }
  try {
    const res = await executeAccountOperation(acct.id, 'remove-patient', { patientId: p.id })
    if (res.data?.error) {
      ElMessage.error(res.data.error)
      return
    }
    if (res.data?.result?.code !== 0) {
      ElMessage.error(res.data?.result?.msg || '删除失败')
      return
    }
    const r = await getAccountPatients(acct.id)
    patientsMap.value = { ...patientsMap.value, [acct.id]: r.data || [] }
    ElMessage.success('已删除')
  } catch (e) {
    ElMessage.error(e.response?.data?.error || e.message || '删除失败')
  }
}

// ── 任务操作 ──
function openConfig(task) {
  configTaskId.value        = task.id
  configDialogVisible.value = true
}

async function handleStart(task) {
  try {
    await startTask(task.id)
    runtimeStatus[task.id] = { status: 'initializing' }
    delete taskLiveStats[task.id]   // 清掉上轮"最后一帧"快照，避免新一轮初始化时显示残留
    startStatsPoller(task.id)
    ElMessage.success('启动中...')
  } catch (_) {}
}

async function handleStop(task) {
  try {
    await stopTask(task.id)
    runtimeStatus[task.id] = { status: 'idle', stopReason: 'manual' }
    stopStatsPoller(task.id)
    ElMessage.success('已停止')
  } catch (_) {}
}

async function handleDeleteTask(task) {
  const label = `${task.doctor_code || task.dept_code || '—'} / ${task.lock_plan_date || '—'}`
  await ElMessageBox.confirm(`确定删除任务「${label}」？`, '确认删除', { type: 'warning' })
  await deleteTask(task.id)
  ElMessage.success('已删除')
  await Promise.all([reloadTasks(), reloadAccounts()])
}

async function openCreateTask(acct) {
  taskTargetAccount.value = acct
  Object.assign(taskForm, { doctor_code: null, lock_plan_date: defaultLockDate(), patient_id: null, proxy_template_ids: [] })
  doctorQuery.value = ''
  patients.value    = []
  taskDialog.value  = true
  patientsLoading.value = true
  try {
    const res = await getAccountPatients(acct.id)
    patients.value = res.data || []
  } catch (_) {} finally { patientsLoading.value = false }
}

function filterDoctors(query) { doctorQuery.value = query }

async function doCreateTask() {
  taskSaving.value = true
  try {
    await createTask({
      account_id:            taskTargetAccount.value.id,
      doctor_code:           taskForm.doctor_code   || null,
      lock_plan_date:        taskForm.lock_plan_date || null,
      patient_id:            taskForm.patient_id    || null,
      proxy_template_ids:    taskForm.proxy_template_ids,
      proxy_template_offset: 0,
    })
    taskDialog.value = false
    ElMessage.success('任务已创建')
    await Promise.all([reloadTasks(), reloadAccounts()])
    const acctId = taskTargetAccount.value.id
    if (!expandedIds.value.has(acctId)) {
      toggleExpand(acctId)
    } else {
      await loadTaskProxiesForAccount(acctId)
    }
  } finally { taskSaving.value = false }
}

// ── WebSocket ──
subscribe('all-tasks', (data) => {
  // 🆕 任务停止时携带 stopReason + finalStats（来自 TaskRunner._checkAllStopped），
  //    用于在停止瞬间冻结显示"最后一帧"+"停止原因"，避免 30s 轮询窗口内瞬切回基础显示
  runtimeStatus[data.taskId] = {
    status: data.status,
    stopReason: data.reason || null,
  }
  if (data.status === 'idle' && Array.isArray(data.finalStats) && data.finalStats.length) {
    taskLiveStats[data.taskId] = data.finalStats
  }
  if (data.status === 'running' || data.status === 'initializing') {
    startStatsPoller(data.taskId)
  } else {
    stopStatsPoller(data.taskId)
  }
})

subscribe('proxy-assignment-changed', (data) => {
  const affected = data.accountIds || []
  for (const id of expandedIds.value) {
    if (affected.length === 0 || affected.some(aid => Number(aid) === id)) {
      loadTaskProxiesForAccount(id)
    }
  }
  reloadAccounts()
})

onUnmounted(() => {
  Object.keys(statsPollers).forEach(id => clearInterval(statsPollers[id]))
})

// ── 操作代理分配 ──
const opsProxyDialog   = ref(false)
const opsProxyTarget   = ref(null)
const opsProxies       = ref([])
const opsProxySaving   = ref(false)
const opsProxySelected = ref(null)
const opsProxyLoading  = ref(false)
// 仅云端 SSH 代理（proxy_type='ssh' 且 port 为空）无本地端口，不能作为账号操作代理
const opsProxiesUsable = computed(() => opsProxies.value.filter(p => !(p.proxy_type === 'ssh' && !p.port)))
const autoAssignOpsRunning = ref(false)

async function openOpsProxyDialog(acct) {
  opsProxyTarget.value   = acct
  opsProxySelected.value = acct.ops_proxy_id ?? null
  opsProxyDialog.value   = true
  opsProxyLoading.value  = true
  try {
    const res = await getProxies({ ops_enabled: '1' })
    opsProxies.value = res.data || []
  } catch (_) {} finally {
    opsProxyLoading.value = false
  }
}

async function saveOpsProxy() {
  opsProxySaving.value = true
  try {
    const res = await setAccountOpsProxy(opsProxyTarget.value.id, opsProxySelected.value)
    const idx = accounts.value.findIndex(a => a.id === opsProxyTarget.value.id)
    if (idx >= 0) accounts.value[idx] = res.data
    opsProxyDialog.value = false
    ElMessage.success('操作代理已更新')
  } catch (_) {} finally {
    opsProxySaving.value = false
  }
}

async function doAutoAssignOpsAll() {
  autoAssignOpsRunning.value = true
  try {
    const res = await autoAssignOpsAll()
    const d = res.data
    if (d.assigned === 0) ElMessage.info(`所有账号已有操作代理，无需分配（处理了 ${d.accountsProcessed} 个账号）`)
    else ElMessage.success(`自动分配完成：为 ${d.assigned} 个账号分配了操作代理`)
    await reloadAccounts()
  } finally {
    autoAssignOpsRunning.value = false
  }
}

// ── 任务代理自动分配 ──
async function doAutoAssignProxy(acct) {
  if (accountHasRunningTask(acct.id)) {
    ElMessage.warning('该账号有任务正在运行，请先停止后再分配代理')
    return
  }
  try {
    await autoAssignProxies(acct.id)
    await reloadAccounts()
    if (expandedIds.value.has(acct.id)) await loadTaskProxiesForAccount(acct.id)
    ElMessage.success('代理自动分配完成')
  } catch (e) {
    ElMessage.error(e.message || '分配失败')
  }
}

// ── 批量选择 ──
const selectedBatchIds  = ref(new Set())
const batchRunning      = ref(false)
const batchProgressDialog = ref(false)
const batchProgressOp   = ref('')
const batchProgressItems = ref([])

function toggleBatchSelect(id) {
  const s = new Set(selectedBatchIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedBatchIds.value = s
}

function selectAll() {
  selectedBatchIds.value = new Set(filtered.value.map(a => a.id))
}

async function runBatchEnable() {
  const targets = accounts.value.filter(a => selectedBatchIds.value.has(a.id))
  if (targets.length === 0) return
  batchRunning.value = true
  try {
    const results = await Promise.allSettled(
      targets.map(a => setAccountEnabled(a.id, true).then(r => ({ id: a.id, data: r.data })))
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const idx = accounts.value.findIndex(a => a.id === r.value.id)
        if (idx >= 0) accounts.value[idx] = r.value.data
      }
    }
    const ok = results.filter(r => r.status === 'fulfilled').length
    ElMessage.success(`已启用 ${ok} 个账号`)
  } finally {
    batchRunning.value = false
  }
}

async function runBatchDisable() {
  const targets = accounts.value.filter(a => selectedBatchIds.value.has(a.id))
  if (targets.length === 0) return
  batchRunning.value = true
  try {
    const results = await Promise.allSettled(
      targets.map(a => setAccountEnabled(a.id, false).then(r => ({ id: a.id, data: r.data })))
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const idx = accounts.value.findIndex(a => a.id === r.value.id)
        if (idx >= 0) accounts.value[idx] = r.value.data
      }
    }
    const ok = results.filter(r => r.status === 'fulfilled').length
    ElMessage.success(`已禁用 ${ok} 个账号`)
  } finally {
    batchRunning.value = false
  }
}

function clearBatchSelect() {
  selectedBatchIds.value = new Set()
}

async function runBatchOp(opType) {
  const ids = [...selectedBatchIds.value]
  const targets = accounts.value.filter(a => ids.includes(a.id) && a.enabled === 1)
  if (targets.length === 0) { ElMessage.warning('没有可操作的启用账号'); return }

  batchProgressOp.value = opType
  batchProgressItems.value = targets.map(a => ({ accountId: a.id, mobile: a.mobile, status: 'pending', msg: '' }))
  batchProgressDialog.value = true
  batchRunning.value = true

  const CONCURRENCY = 25
  const items = batchProgressItems.value
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    batch.forEach(item => { item.status = 'running' })
    await Promise.all(batch.map(async (item) => {
      try {
        const res = await executeAccountOperation(item.accountId, opType, {})
        if (res.data?.error) {
          item.status = 'error'; item.msg = res.data.error
        } else {
          item.status = 'done'
          const r = res.data?.result
          if (opType === 'messages')        item.msg = `保存 ${r?.savedCount ?? 0} 条消息`
          else if (opType === 'source-records') item.msg = `保存 ${r?.savedCount ?? 0} 条记录`
          else item.msg = r?.msg || '成功'
        }
      } catch (e) {
        item.status = 'error'
        item.msg = e.message || '失败'
      }
    }))
  }

  batchRunning.value = false
  if (['login', 'add-patient'].includes(opType)) await loadAll()
}

async function runBatchStartTasks() {
  const ids = [...selectedBatchIds.value]
  const targets = accounts.value.filter(a => ids.includes(a.id) && a.enabled === 1)
  if (targets.length === 0) { ElMessage.warning('没有可操作的启用账号'); return }

  batchProgressOp.value = '批量启动任务'
  const taskTargets = []
  for (const acct of targets) {
    const tasks = accountTasksMap.value[acct.id] || []
    for (const t of tasks) {
      if (t.enabled && !isRunning(t.id)) taskTargets.push({ accountId: acct.id, mobile: acct.mobile, taskId: t.id })
    }
  }

  if (taskTargets.length === 0) { ElMessage.warning('所选账号无可启动的已启用任务'); return }

  batchProgressItems.value = taskTargets.map(t => ({ accountId: t.accountId, mobile: t.mobile, taskId: t.taskId, status: 'pending', msg: '' }))
  batchProgressDialog.value = true
  batchRunning.value = true

  // 滚动 worker 调度（rolling window）：固定 CONCURRENCY 个 worker 各自循环取下一个 task，
  // 谁完成谁补位，避免 Promise.all 分批的"木桶效应"（一批被慢 task 拖累整批）。
  // 速率最终由后端 _startSem(15) + _probeSem(50) + per-agentUrl 熔断接管，前端放开并发。
  const CONCURRENCY = 100
  const items = batchProgressItems.value
  let _nextIdx = 0
  const runOne = async (item) => {
    item.status = 'running'
    try {
      await startTask(item.taskId)
      runtimeStatus[item.taskId] = { status: 'initializing' }
      startStatsPoller(item.taskId)
      item.status = 'done'; item.msg = '已启动'
    } catch (e) {
      item.status = 'error'; item.msg = e.message || '失败'
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (_nextIdx < items.length) {
      const idx = _nextIdx++
      await runOne(items[idx])
    }
  })
  await Promise.all(workers)

  batchRunning.value = false
}

async function runBatchStopTasks() {
  const ids = [...selectedBatchIds.value]
  const targets = accounts.value.filter(a => ids.includes(a.id))
  if (targets.length === 0) return

  batchProgressOp.value = '批量停止任务'
  const taskTargets = []
  for (const acct of targets) {
    const tasks = accountTasksMap.value[acct.id] || []
    for (const t of tasks) {
      if (isRunning(t.id)) taskTargets.push({ accountId: acct.id, mobile: acct.mobile, taskId: t.id })
    }
  }

  if (taskTargets.length === 0) { ElMessage.warning('所选账号无正在运行的任务'); return }

  batchProgressItems.value = taskTargets.map(t => ({ accountId: t.accountId, mobile: t.mobile, taskId: t.taskId, status: 'pending', msg: '' }))
  batchProgressDialog.value = true
  batchRunning.value = true

  const CONCURRENCY = 25
  const items = batchProgressItems.value
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    batch.forEach(item => { item.status = 'running' })
    await Promise.all(batch.map(async (item) => {
      try {
        await stopTask(item.taskId)
        runtimeStatus[item.taskId] = { status: 'idle' }
        stopStatsPoller(item.taskId)
        item.status = 'done'; item.msg = '已停止'
      } catch (e) {
        item.status = 'error'; item.msg = e.message || '失败'
      }
    }))
  }

  batchRunning.value = false
}

// ── 批量建任务 ──
const batchTaskDialog = ref(false)
const batchTaskForm   = reactive({ doctor_codes: [], lock_plan_date: '', proxy_template_ids: [] })

// ── 批量添患者 ──
const batchPatientDialog  = ref(false)
const batchPatientMinAge  = ref(18)
const batchPatientMaxAge  = ref(60)
const batchPatientGender  = ref('')

const selectedEnabledCount = computed(() =>
  accounts.value.filter(a => selectedBatchIds.value.has(a.id) && a.enabled === 1).length
)

function openBatchCreateTasks() {
  const ids = [...selectedBatchIds.value]
  const targets = accounts.value.filter(a => ids.includes(a.id) && a.enabled === 1)
  if (targets.length === 0) { ElMessage.warning('没有可操作的启用账号'); return }
  Object.assign(batchTaskForm, { doctor_codes: [], lock_plan_date: defaultLockDate(), proxy_template_ids: [] })
  doctorQuery.value = ''
  batchTaskDialog.value = true
}

function pickPatientForDoctor(accountId, doctorCode) {
  const patients = patientsMap.value[accountId] || []
  if (patients.length === 0) return null
  const doc = doctors.value.find(d => d.doctor_code === doctorCode)
  const deptName = doc?.dept_name || ''
  let matched = null
  if (deptName.includes('妇科')) {
    matched = patients.find(p => p.gender === '女' && p.age != null && p.age >= 18)
  } else if (deptName.includes('儿科')) {
    matched = patients.find(p => p.age != null && p.age < 18)
  }
  return (matched ?? patients[0])?.id ?? null
}

async function doRunBatchCreateTasks() {
  if (batchTaskForm.doctor_codes.length === 0) { ElMessage.warning('请选择至少一个目标医生'); return }
  if (!batchTaskForm.lock_plan_date)           { ElMessage.warning('请选择目标日期'); return }

  batchTaskDialog.value = false

  const ids = [...selectedBatchIds.value]
  const targets = accounts.value.filter(a => ids.includes(a.id) && a.enabled === 1)
  if (targets.length === 0) return

  const tmplIds = batchTaskForm.proxy_template_ids // 可能为空数组
  const doctorCodes = batchTaskForm.doctor_codes

  batchProgressOp.value = '批量建任务'
  batchProgressItems.value = targets.map((a, i) => {
    const doctorCode = doctorCodes[i % doctorCodes.length]
    return {
      accountId:  a.id,
      mobile:     a.mobile,
      taskId:     null,
      doctorCode,
      patientId:  pickPatientForDoctor(a.id, doctorCode),
      status:     'pending',
      msg:        '',
    }
  })
  batchProgressDialog.value = true
  batchRunning.value = true

  // 批次内全局轮询偏移：每个任务返回 assigned_count，下一个任务的 offset 累加
  // 串行（顺序）执行确保 offset 正确推进
  let globalOffset = 0
  const items = batchProgressItems.value
  for (const item of items) {
    item.status = 'running'
    try {
      const res = await createTask({
        account_id:            item.accountId,
        doctor_code:           item.doctorCode,
        lock_plan_date:        batchTaskForm.lock_plan_date,
        patient_id:            item.patientId,
        proxy_template_ids:    tmplIds,
        proxy_template_offset: globalOffset,
      })
      const assigned = res?.data?.assigned_count ?? 0
      item.status = 'done'
      item.msg = tmplIds.length > 0
        ? `已创建（${assigned} 代理，模板 [${tmplIds.map((id, k) => assigned > 0 ? tmplIds[(globalOffset + k) % tmplIds.length] : id).slice(0, assigned).join(',')}]）`
        : `已创建（${assigned} 代理）`
      globalOffset += assigned
    } catch (e) {
      item.status = 'error'
      item.msg = e.response?.data?.error || e.message || '失败'
    }
  }

  batchRunning.value = false
  await Promise.all([reloadTasks(), reloadAccounts()])
}

function openBatchAddPatient() {
  const targets = accounts.value.filter(a => selectedBatchIds.value.has(a.id) && a.enabled === 1)
  if (targets.length === 0) { ElMessage.warning('没有可操作的启用账号'); return }
  batchPatientDialog.value = true
}

async function doRunBatchAddPatient() {
  const targets = accounts.value.filter(a => selectedBatchIds.value.has(a.id) && a.enabled === 1)
  if (targets.length === 0) return

  batchPatientDialog.value = false
  batchProgressOp.value    = '批量添加患者'
  batchProgressItems.value = targets.map(a => ({ accountId: a.id, mobile: a.mobile, status: 'pending', msg: '' }))
  batchProgressDialog.value = true
  batchRunning.value = true

  const CONCURRENCY = 25
  const items = batchProgressItems.value
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    batch.forEach(item => { item.status = 'running' })
    await Promise.all(batch.map(async (item) => {
      try {
        const genRes = await generatePatientInfo(batchPatientMinAge.value, batchPatientMaxAge.value, batchPatientGender.value || undefined)
        const { name, idNo, sex } = genRes.data
        const res = await executeAccountOperation(item.accountId, 'add-patient', { name, idNo, sex })
        const result = res.data?.result
        if (res.data?.error) {
          item.status = 'error'; item.msg = res.data.error
        } else if (result?.code === 0) {
          item.status = 'done'; item.msg = `${name} 添加成功`
        } else {
          item.status = 'error'; item.msg = result?.msg || '添加失败'
        }
      } catch (e) {
        item.status = 'error'; item.msg = e.message || '失败'
      }
    }))
  }

  batchRunning.value = false
  await loadAllPatients()
}

// ── 批量删任务 ──
async function runBatchDeleteTasks() {
  const ids = [...selectedBatchIds.value]
  const targets = accounts.value.filter(a => ids.includes(a.id))
  if (targets.length === 0) return

  const taskTargets = []
  for (const acct of targets) {
    const tasks = accountTasksMap.value[acct.id] || []
    for (const t of tasks) {
      taskTargets.push({ accountId: acct.id, mobile: acct.mobile, taskId: t.id, label: `${t.doctor_code || t.dept_code || '—'}/${t.lock_plan_date || '—'}` })
    }
  }
  if (taskTargets.length === 0) { ElMessage.warning('所选账号无任务'); return }

  const runningCount = taskTargets.filter(t => isRunning(t.taskId)).length
  if (runningCount > 0) { ElMessage.warning(`有 ${runningCount} 个任务正在运行，请先停止后再删除`); return }

  batchProgressOp.value = '批量删除任务'
  batchProgressItems.value = taskTargets.map(t => ({
    accountId: t.accountId,
    mobile:    t.mobile,
    taskId:    t.taskId,
    status:    'pending',
    msg:       t.label,
  }))
  batchProgressDialog.value = true
  batchRunning.value = true

  const CONCURRENCY = 25
  const items = batchProgressItems.value
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    batch.forEach(item => { item.status = 'running' })
    await Promise.all(batch.map(async (item) => {
      try {
        await deleteTask(item.taskId)
        item.status = 'done'; item.msg = '已删除'
      } catch (e) {
        item.status = 'error'; item.msg = e.response?.data?.error || e.message || '失败'
      }
    }))
  }

  batchRunning.value = false
  await Promise.all([reloadTasks(), reloadAccounts()])
}

// ── 批量删账号 ──
async function runBatchDeleteAccounts() {
  const targets = accounts.value.filter(a => selectedBatchIds.value.has(a.id))
  if (targets.length === 0) return

  const runningTargets = targets.filter(a => accountHasRunningTask(a.id))
  const deletable = targets.filter(a => !accountHasRunningTask(a.id))

  let confirmMsg = `确定删除选中的 ${targets.length} 个账号？\n此操作将同时清除这些账号的设备、会话、患者等全部数据，且不可恢复。`
  if (runningTargets.length > 0) {
    confirmMsg += `\n\n注意：以下 ${runningTargets.length} 个账号有任务正在运行，将自动跳过：\n${runningTargets.map(a => a.mobile).join('、')}`
  }
  if (deletable.length === 0) {
    ElMessage.warning('所选账号均有任务正在运行，无法删除')
    return
  }

  try {
    await ElMessageBox.confirm(confirmMsg, '批量删除账号', {
      type: 'warning',
      confirmButtonText: `确认删除 ${deletable.length} 个`,
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    })
  } catch (_) { return }

  batchProgressOp.value = '批量删除账号'
  batchProgressItems.value = [
    ...deletable.map(a => ({ accountId: a.id, mobile: a.mobile, status: 'pending', msg: '' })),
    ...runningTargets.map(a => ({ accountId: a.id, mobile: a.mobile, status: 'error', msg: '跳过：任务运行中' })),
  ]
  batchProgressDialog.value = true
  batchRunning.value = true

  const CONCURRENCY = 10
  const items = batchProgressItems.value.filter(i => i.status === 'pending')
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    batch.forEach(item => { item.status = 'running' })
    await Promise.all(batch.map(async (item) => {
      try {
        await deleteAccount(item.accountId)
        item.status = 'done'; item.msg = '已删除'
      } catch (e) {
        item.status = 'error'; item.msg = e.response?.data?.error || e.message || '失败'
      }
    }))
  }

  batchRunning.value = false

  const deletedIds = new Set(
    batchProgressItems.value.filter(i => i.status === 'done').map(i => i.accountId)
  )
  accounts.value = accounts.value.filter(a => !deletedIds.has(a.id))
  const s = new Set(expandedIds.value)
  for (const id of deletedIds) s.delete(id)
  expandedIds.value = s
  selectedBatchIds.value = new Set([...selectedBatchIds.value].filter(id => !deletedIds.has(id)))
  await reloadTasks()
}

// ── 请求记录 ──
const reqLogDialog      = ref(false)
const reqLogLoading     = ref(false)
const reqLogs           = ref([])
const reqLogTableRef    = ref(null)
const expandedReqLogKeys = ref([])

async function openReqLogDialog(accountId) {
  reqLogDialog.value       = true
  reqLogLoading.value      = true
  reqLogs.value            = []
  expandedReqLogKeys.value = []
  try {
    const res = await getAccountRequestLogs(accountId)
    reqLogs.value = res.data || []
  } catch (_) {} finally {
    reqLogLoading.value = false
  }
}

function toggleReqLogExpand(row) {
  const key = row.id
  const idx = expandedReqLogKeys.value.indexOf(key)
  expandedReqLogKeys.value = idx === -1 ? [key] : []
}

function extractApiName(url) {
  if (!url) return '—'
  const m = url.match(/\/([^\/]+\.hsr)$/)
  return m ? m[1] : (url.split('/').pop() || '—')
}

function formatJsonStr(str) {
  if (!str) return '（空）'
  try { return JSON.stringify(JSON.parse(str), null, 2) } catch (_) { return str }
}

// ── 账号操作日志 ──
const opRunning         = ref('')
const opLogDialog       = ref(false)
const opLogs            = ref([])
const opError           = ref('')
const opResult          = ref(null)
const opRecords         = ref([])
const opMessages        = ref([])
const opCurrentAccountId  = ref(null)
const cancellingTradeId   = ref(null)
const recordTableRef      = ref(null)
const expandedRecordKeys  = ref([])

const OP_TITLES = {
  'source-records':      '获取挂号记录',
  'messages':            '获取消息',
  'login':               '登录',
  'add-patient':         '添加患者',
  'remove-patient':      '删除患者',
  'user-behavior':       '执行用户行为',
  'cancel-registration': '取消挂号',
}
const opDialogTitle = computed(() => OP_TITLES[opRunning.value] || (opRecords.value.length > 0 ? '挂号记录' : opMessages.value.length > 0 ? '消息列表' : '操作结果'))

function isCancellable(record) {
  const s = record.source_status_name
  return !s || s === '' || s === '预约成功'
}

function toggleRecordExpand(row) {
  const key = row.source_trade_id
  const idx = expandedRecordKeys.value.indexOf(key)
  if (idx === -1) {
    expandedRecordKeys.value = [key]
  } else {
    expandedRecordKeys.value = []
  }
}

function recordStatusType(record) {
  const s = record.source_status_name
  if (!s || s === '') return 'warning'
  if (s === '预约成功') return 'success'
  if (s.includes('取消') || s.includes('退')) return 'info'
  return ''
}

async function handleOp(accountId, operationType, opts = {}) {
  opCurrentAccountId.value = accountId
  opRunning.value   = operationType
  opLogs.value      = []
  opError.value     = ''
  opResult.value    = null
  opRecords.value   = []
  opMessages.value  = []
  opLogDialog.value = true
  try {
    const res = await executeAccountOperation(accountId, operationType, opts)
    opLogs.value   = res.data.logs  || []
    opError.value  = res.data.error || ''
    opResult.value = res.data.result
    if (operationType === 'source-records' && res.data.result?.records) {
      opRecords.value = res.data.result.records
    }
    if (operationType === 'messages' && res.data.result?.messages) {
      opMessages.value = res.data.result.messages
    }
    if (['add-patient', 'remove-patient'].includes(operationType)) {
      try {
        const r = await getAccountPatients(accountId)
        patientsMap.value = { ...patientsMap.value, [accountId]: r.data || [] }
      } catch (_) {}
    }
    if (operationType === 'login') {
      try { await reloadAccounts() } catch (_) {}
    }
  } catch (e) {
    opError.value = e.response?.data?.error || e.message || '请求失败'
  } finally {
    opRunning.value = ''
  }
}

async function handleCancelRegistration(record) {
  try {
    await ElMessageBox.confirm(
      `确定取消 ${record.patient_name || ''} 在 ${record.reg_date || ''} ${record.visit_time || ''} 的预约（${record.doctor_name || record.dept_name || ''}）？`,
      '取消挂号',
      { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '返回',
        confirmButtonClass: 'el-button--danger' }
    )
  } catch (_) { return }
  cancellingTradeId.value = record.source_trade_id
  try {
    const accountId = opCurrentAccountId.value
    const res = await executeAccountOperation(accountId, 'cancel-registration', { sourceTradeId: record.source_trade_id })
    if (res.data.error) {
      ElMessage.error(res.data.error)
    } else {
      ElMessage.success(res.data.result?.msg || '取消成功')
      await handleOp(accountId, 'source-records')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.error || e.message || '取消失败')
  } finally {
    cancellingTradeId.value = null
  }
}

// ── 批量生成账号 ──
const generateDialog = ref(false)
const generateSaving = ref(false)
const generateForm   = reactive({ accountType: 'wechat', platform: 'ios', count: 10 })

async function doGenerate() {
  generateSaving.value = true
  try {
    const res = await generateAccounts({
      accountType: generateForm.accountType,
      platform:    generateForm.accountType === 'app' ? generateForm.platform : undefined,
      count:       generateForm.count,
    })
    const { success, fail } = res.data
    ElMessage.success(`生成完成：成功 ${success} 个${fail > 0 ? `，失败 ${fail} 个` : ''}`)
    generateDialog.value = false
    await loadAll()
  } catch (_) {} finally {
    generateSaving.value = false
  }
}

// ── App端批量注册账号 ──
// 每行独立 sessionId,可并行进行"获取验证码→发送短信→注册"流程,
// 利用 SMS 到达延迟期间用户在多行之间切换填写,提升整体效率。
const batchRegisterDialog = ref(false)
const regRows             = reactive([])
let _regUidCounter = 0

function makeRegRow() {
  return {
    uid: ++_regUidCounter,
    platform: 'android',
    mobile: '',
    picCode: '',
    smsCode: '',
    password: '',
    remark: '',
    sessionId: null,
    captchaImg: null,
    status: 'idle',   // idle | captcha-ready | sms-sent | done
    busy: null,       // null | 'captcha' | 'send' | 'submit'
    errMsg: '',
  }
}

function openBatchRegisterDialog() {
  regRows.splice(0, regRows.length)
  for (let i = 0; i < 10; i++) regRows.push(makeRegRow())
  batchRegisterDialog.value = true
  // 打开后并行为每行拉 captcha;失败的行用户可点占位图重试
  for (const row of regRows) loadRowCaptcha(row).catch(() => {})
}

function addRow() {
  const row = makeRegRow()
  regRows.push(row)
  loadRowCaptcha(row).catch(() => {})
}

function removeRow(idx) {
  const row = regRows[idx]
  if (!row) return
  if (row.sessionId && row.status !== 'done') {
    cancelRegisterSession(row.sessionId).catch(() => {})
  }
  regRows.splice(idx, 1)
}

function onBatchRegisterClosed() {
  for (const row of regRows) {
    if (row.sessionId && row.status !== 'done') {
      cancelRegisterSession(row.sessionId).catch(() => {})
    }
  }
  regRows.splice(0, regRows.length)
}

async function loadRowCaptcha(row) {
  if (row.busy) return
  row.busy = 'captcha'
  row.errMsg = ''
  try {
    if (!row.sessionId) {
      const sessRes = await createRegisterSession(row.platform)
      row.sessionId = sessRes.data.sessionId
    }
    const capRes = await getRegisterCaptcha(row.sessionId)
    row.captchaImg = capRes.data.image
    row.picCode = ''
    if (row.status === 'idle') row.status = 'captcha-ready'
  } catch (e) {
    row.errMsg = e.response?.data?.error || e.message || '获取验证码失败'
  } finally {
    row.busy = null
  }
}

function onPlatformChange(row) {
  // 平台变化 → 旧 session 失效,取消并重拉
  if (row.sessionId) {
    cancelRegisterSession(row.sessionId).catch(() => {})
    row.sessionId = null
  }
  row.captchaImg = null
  row.picCode = ''
  row.smsCode = ''
  row.status = 'idle'
  row.errMsg = ''
  loadRowCaptcha(row).catch(() => {})
}

function canSendRow(row) {
  return !row.busy
    && row.status !== 'done'
    && !!row.captchaImg
    && /^1[3-9]\d{9}$/.test(row.mobile)
    && row.picCode.length > 0
}

function canSubmitRow(row) {
  return !row.busy
    && row.status === 'sms-sent'
    && row.smsCode.length > 0
    && row.password.length >= 6
}

async function doSendRow(row) {
  if (!canSendRow(row)) return
  row.busy = 'send'
  row.errMsg = ''
  try {
    const res = await sendRegisterSms({
      sessionId:     row.sessionId,
      mobileNo:      row.mobile,
      picVerifyCode: row.picCode,
    })
    if (res.data?.code !== 0) {
      row.errMsg = res.data?.msg || '发送失败，请检查验证码'
    } else {
      row.status = 'sms-sent'
    }
  } catch (e) {
    row.errMsg = e.response?.data?.error || e.message || '发送失败'
  } finally {
    row.busy = null
  }
}

async function doSubmitRow(row) {
  if (!canSubmitRow(row)) return
  row.busy = 'submit'
  row.errMsg = ''
  try {
    const res = await submitRegister({
      sessionId:  row.sessionId,
      mobileNo:   row.mobile,
      verifyCode: row.smsCode,
      password:   row.password,
      remark:     row.remark || null,
    })
    if (res.data?.code !== 0) {
      row.errMsg = res.data?.msg || '注册失败'
    } else {
      row.status = 'done'
      row.sessionId = null
      await loadAll()
    }
  } catch (e) {
    row.errMsg = e.response?.data?.error || e.message || '注册失败'
  } finally {
    row.busy = null
  }
}

// ── App端手动添加账号 ──
const manualSaving    = ref(false)
const manualForm      = reactive({ mobile: '', password: '', platform: 'ios' })
const manualBatchText = ref('')
const manualBatchMode = ref(false)

async function doManualAdd() {
  manualSaving.value = true
  try {
    let payload
    if (manualBatchMode.value) {
      const lines = manualBatchText.value.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length === 0) { ElMessage.warning('请填写账号信息'); return }
      const accounts_list = lines.map(line => {
        const parts = line.split(/[\s,，]+/)
        return { mobile: parts[0] || '', password: parts[1] || '', platform: manualForm.platform }
      })
      payload = { accounts: accounts_list }
    } else {
      if (!manualForm.mobile || !manualForm.password) { ElMessage.warning('请填写手机号和密码'); return }
      payload = { mobile: manualForm.mobile, password: manualForm.password, platform: manualForm.platform }
    }
    const res = await addManualAccount(payload)
    const { success, fail, errors } = res.data
    if (success > 0) {
      ElMessage.success(`添加成功 ${success} 个${fail > 0 ? `，失败 ${fail} 个` : ''}`)
      if (errors?.length) console.warn('添加账号部分失败:', errors)
      generateDialog.value = false
      Object.assign(manualForm, { mobile: '', password: '', platform: 'ios' })
      manualBatchText.value = ''
      await loadAll()
    } else {
      ElMessage.error(`全部失败：${errors?.[0] || '未知错误'}`)
    }
  } catch (e) {
    ElMessage.error(e.message || '添加失败')
  } finally {
    manualSaving.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
/* ── 整体页面 ── */
.accounts-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 84px);
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .08);
  overflow: hidden;
}

/* ── 顶部工具栏 ── */
.top-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #e4e7ed;
  background: #fff;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.toolbar-middle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: center;
  flex-wrap: wrap;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
}
.sel-count {
  font-size: 13px;
  color: #409eff;
  font-weight: 600;
  flex-shrink: 0;
}
.sel-link {
  font-size: 12px;
  color: #409eff;
  text-decoration: none;
  cursor: pointer;
  flex-shrink: 0;
  line-height: 1;
}
.sel-link:hover { text-decoration: underline; }

/* ── 账号列表滚动区 ── */
.account-list {
  flex: 1;
  overflow-y: auto;
  background: #f5f7fa;
  padding: 6px 8px;
}

/* ── 单个账号卡片（行+展开） ── */
.acct-row-wrap {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  margin-bottom: 4px;
  overflow: hidden;
  transition: border-color .15s;
}
.acct-row-wrap.is-expanded {
  border-color: #b3d8ff;
}

/* ── 账号主行 ── */
.acct-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-left: 3px solid transparent;
  min-height: 42px;
  transition: background .1s;
  cursor: pointer;
}
.acct-row:hover { background: #fafbff; }
.acct-row.is-enabled  { border-left-color: #67c23a; }
.acct-row.is-disabled { border-left-color: #c0c4cc; background: #fafafa; }
.acct-row.is-sel      { background: #ecf5ff !important; border-left-color: #409eff !important; }
.acct-row.is-risk     { border-left-color: #f56c6c !important; background: rgba(245,108,108,.04); }
.acct-row.is-banned   { border-left-color: #7c3aed !important; background: rgba(124,58,237,.04); }

/* Checkbox：hover 或有选中时显示 */
.row-checkbox {
  opacity: 0;
  transition: opacity .12s;
  flex-shrink: 0;
}
.acct-row:hover .row-checkbox,
.acct-row.is-sel .row-checkbox,
.acct-row.has-sel .row-checkbox {
  opacity: 1;
}

/* 手机号 */
.acct-mobile {
  font-family: monospace;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  letter-spacing: .5px;
  flex-shrink: 0;
  min-width: 108px;
}
.acct-row.is-disabled .acct-mobile { color: #bbbfc4; }

/* 手机号可点击复制 */
.acct-mobile-copy {
  cursor: pointer;
  border-radius: 3px;
  padding: 0 4px;
  transition: background-color .15s;
}
.acct-mobile-copy:hover {
  background: #ecf5ff;
  color: #409eff;
}

/* 类型标签 */
.acct-type-tag {
  font-size: 11px !important;
  padding: 0 4px !important;
  height: 18px !important;
  line-height: 18px !important;
  flex-shrink: 0;
}

/* 密码 / UUID 显示标签 */
.acct-info-pill {
  font-family: monospace;
  font-size: 11px;
  line-height: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  flex-shrink: 0;
  user-select: text;
  white-space: nowrap;
}
.acct-password-pill {
  background: #fdf6ec;
  border: 1px solid #f5dab1;
  color: #b88230;
}
.acct-uuid-pill {
  background: #f0f9eb;
  border: 1px solid #c2e7b0;
  color: #529b2e;
}
.acct-row.is-disabled .acct-info-pill {
  opacity: .55;
}

/* ── 就诊人区域 ── */
.patient-area {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}
.patient-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.patient-emoji {
  font-size: 16px;
  line-height: 1;
  display: block;
}
.patient-del {
  position: absolute;
  top: -5px;
  right: -5px;
  font-size: 8px;
  width: 13px;
  height: 13px;
  background: #f56c6c;
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s;
  font-weight: 700;
  z-index: 1;
  user-select: none;
}
.patient-icon-wrap:hover .patient-del { opacity: 1; }
.patient-add {
  width: 20px;
  height: 20px;
  border: 1.5px dashed #c0c4cc;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #909399;
  cursor: pointer;
  transition: all .12s;
  flex-shrink: 0;
  user-select: none;
}
.patient-add:hover { border-color: #409eff; color: #409eff; }

/* ── 代理徽章 ── */
.proxy-badge {
  font-size: 11px;
  color: #909399;
  background: #f0f2f5;
  border-radius: 4px;
  padding: 2px 6px;
  flex-shrink: 0;
  white-space: nowrap;
}
.proxy-badge.proxy-badge-dim { color: #c5c8ce; background: #ebebeb; }

/* ── 操作代理徽章 ── */
.ops-proxy-badge {
  font-size: 11px;
  color: #909399;
  background: #f0f2f5;
  border-radius: 4px;
  padding: 2px 6px;
  flex-shrink: 0;
  white-space: nowrap;
  cursor: pointer;
  border: 1px dashed #c0c4cc;
  transition: all .15s;
}
.ops-proxy-badge:hover { border-color: #409eff; color: #409eff; background: #f0f4ff; }
.ops-proxy-badge.ops-proxy-badge-set { color: #67c23a; background: #f0f9eb; border-color: #b3e19d; }
.ops-proxy-badge.ops-proxy-badge-set:hover { color: #529b2e; border-color: #67c23a; }

/* ── 任务状态点 ── */
.task-dots {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
  max-width: 200px;
}
.task-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-on  { background: #67c23a; box-shadow: 0 0 5px rgba(103, 194, 58, .7); }
.dot-off { background: #f56c6c; box-shadow: 0 0 4px rgba(245, 108, 108, .5); }

/* ── 账号操作按钮（挂号/消息）── */
.acct-op-btn {
  flex-shrink: 0 !important;
  padding: 4px 6px !important;
  font-size: 12px !important;
  color: #909399 !important;
  transition: color .15s, background .15s !important;
}
.acct-op-btn:hover {
  color: #409eff !important;
  background: #f0f4ff !important;
}

/* ── 删除账号按钮 ── */
.acct-del-btn {
  flex-shrink: 0 !important;
  padding: 4px !important;
  color: #c0c4cc !important;
  transition: color .15s, background .15s !important;
}
.acct-del-btn:hover {
  color: #f56c6c !important;
  background: #fef0f0 !important;
}

/* ── 展开按钮 ── */
.expand-btn {
  flex-shrink: 0 !important;
  min-width: 64px !important;
  padding: 4px 8px !important;
  font-size: 12px !important;
  color: #606266 !important;
  border-radius: 4px !important;
}
.expand-btn:hover { color: #409eff !important; background: #f0f4ff !important; }
.expand-arrow { margin-right: 3px; font-size: 10px; }
.expand-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  font-size: 11px;
  background: #409eff;
  color: #fff;
  border-radius: 8px;
  padding: 0 4px;
  margin-left: 4px;
  line-height: 1;
}

/* ── 展开的任务列表区 ── */
.task-section {
  border-top: 1px solid #e4e7ed;
  background: #f5f7fa;
  padding: 12px 16px 16px;
}
.task-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

/* ── 列表底栏 ── */
.list-footer {
  padding: 6px 12px;
  font-size: 12px;
  color: #c0c4cc;
  border-top: 1px solid #e4e7ed;
  text-align: right;
  flex-shrink: 0;
  background: #fff;
}

/* ── 空状态 ── */
.list-empty {
  text-align: center;
  padding: 60px 0 40px;
  color: #c0c4cc;
  font-size: 13px;
}
.list-empty p { margin-top: 10px; }

/* ── 任务列表项 ── */
.tasks-empty {
  text-align: center;
  padding: 16px 0;
  color: #c0c4cc;
  font-size: 13px;
}
.task-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 4px;
  border-bottom: 1px solid #e9ecf0;
}
.task-item:last-child { border-bottom: none; }
.task-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.task-item-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.task-item-dot { width: 10px; height: 10px; flex-shrink: 0; }
.task-target   { display: flex; align-items: baseline; gap: 6px; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
.task-doctor   { font-family: monospace; font-weight: 600; font-size: 14px; color: #303133; white-space: nowrap; }
.task-date     { color: #909399; font-size: 13px; white-space: nowrap; flex-shrink: 0; }
.task-patient  { color: #606266; font-size: 13px; white-space: nowrap; flex-shrink: 0; }
.task-item-right { flex-shrink: 0; margin-left: 12px; }

.task-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-left: 20px;
}
.task-meta-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.task-meta-label { color: #909399; }
.task-meta-value { color: #606266; font-weight: 500; }
.task-meta-mono  { font-family: monospace; }

/* ── 代理明细（终端风格） ── */
.task-proxy-panel {
  background: #1a1a2e;
  border-radius: 4px;
  padding: 5px 8px;
  margin-top: 6px;
}
.proxy-stat-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-family: monospace;
  font-size: 11px;
  color: #a0b0c0;
  padding: 2px 0;
  border-bottom: 1px solid #2a2a4a;
}
.proxy-stat-row:last-child { border-bottom: none; }
.proxy-row-risk { background: rgba(245,108,108,.1) !important; border-radius: 2px; }
.proxy-risk-flag { color: #f56c6c; font-weight: 600; font-size: 10px; flex-shrink: 0; }
.proxy-ip   { color: #7ec8e3; min-width: 150px; flex-shrink: 0; }
.proxy-cfg-btn {
  cursor: pointer;
  color: #4a5a6a;
  font-size: 12px;
  padding: 0 2px;
  flex-shrink: 0;
  line-height: 1;
  user-select: none;
  transition: color .15s;
}
.proxy-cfg-btn:hover   { color: #7ec8e3; }
.proxy-cfg-active      { color: #e6a23c !important; }
.proxy-cfg-disabled    { color: #c0c4cc !important; cursor: not-allowed !important; }
.proxy-seg  { color: #90c8a0; }
.proxy-loc  { color: #9090c0; font-size: 10px; }
.proxy-risk { font-size: 10px; padding: 0 4px; border-radius: 3px; }
.risk-none  { color: #67c23a; }
.risk-low   { color: #409eff; }
.risk-mid   { color: #e6a23c; }
.risk-high  { color: #f56c6c; }
.proxy-hb       { color: #e0c070 !important; }
.proxy-lock-ok  { color: #fff; background: #2a7a2a; border-radius: 3px; padding: 0 5px; font-weight: bold; margin-left: 4px; }
.proxy-run-mode { border-radius: 3px; padding: 0 5px; font-size: 10px; font-weight: 600; flex-shrink: 0; }
.run-mode-cloud { color: #fff; background: #409eff; }
.run-mode-local { color: #fff; background: #67c23a; }
.proxy-ch   { color: #6888a0; }
.proxy-ch-ov { color: #d4904c !important; }
.proxy-hosts { color: #8a7eb8; font-size: 10px; }

/* ── 代理通道配置弹窗 ── */
.proxy-cfg-hint { margin-left: 8px; color: #909399; font-size: 12px; }

/* ── 操作日志弹窗 ── */
.op-running {
  display: flex;
  align-items: center;
  color: #606266;
  font-size: 14px;
  padding: 12px 0 4px;
}
.op-log-box {
  background: #1a1a2e;
  border-radius: 4px;
  padding: 10px 12px;
  max-height: 240px;
  overflow-y: auto;
  margin-top: 4px;
}
.op-log-line {
  font-family: monospace;
  font-size: 12px;
  color: #a0b8c8;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── 请求记录展开详情 ── */
.reqlog-detail-expand {
  padding: 12px 20px 12px 40px;
  background: #f8fafc;
}
.reqlog-section-title {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 4px;
}
.reqlog-pre {
  margin: 0;
  padding: 8px 10px;
  background: #1a1a2e;
  color: #a0b8c8;
  font-family: monospace;
  font-size: 12px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}
.reqlog-pre-error {
  color: #f89898;
}

/* ── 挂号记录展开详情 ── */
.record-detail-expand {
  padding: 12px 20px 12px 40px;
  background: #f8fafc;
}
.record-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 24px;
}
.rd-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}
.rd-full { grid-column: span 2; }
.rd-label {
  color: #909399;
  flex-shrink: 0;
  width: 60px;
  text-align: right;
}
.rd-value {
  color: #303133;
  word-break: break-all;
}
.rd-mono {
  font-family: monospace;
  font-size: 11px;
  color: #606266;
}
.batch-reg-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 60vh;
  overflow-y: auto;
}
.batch-reg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
  border-radius: 4px;
}
.batch-reg-row.is-done {
  background: #f0f9eb;
  opacity: 0.7;
}
.reg-captcha-img {
  width: 64px;
  height: 28px;
  border: 1px solid #dcdfe6;
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
  object-fit: cover;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.reg-captcha-img.placeholder {
  background: #fafafa;
  color: #909399;
  font-size: 11px;
  user-select: none;
}
.reg-captcha-img.placeholder:hover {
  background: #f0f0f0;
  border-color: #c0c4cc;
}
.reg-row-tag {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: bold;
  flex-shrink: 0;
}
.reg-row-tag.done {
  background: #67c23a;
  color: #fff;
}
.reg-row-tag.err {
  background: #f56c6c;
  color: #fff;
  cursor: help;
}
.reg-row-del {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #c0c4cc;
  cursor: pointer;
  font-size: 16px;
  flex-shrink: 0;
}
.reg-row-del:hover {
  color: #f56c6c;
}
</style>
