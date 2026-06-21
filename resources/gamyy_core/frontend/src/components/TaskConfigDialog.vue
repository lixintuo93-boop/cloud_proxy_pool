<template>
  <el-dialog
    v-model="visible"
    :title="`配置任务 #${taskId}`"
    width="520px"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <div v-if="loading" style="text-align:center;padding:40px;color:#909399">加载中…</div>

    <div v-else-if="task">
      <div class="cfg-topbar">
        <TaskStatusBadge :status="runtimeStatus.status" :enabled="task.enabled" />
        <el-switch
          v-model="task.enabled" :active-value="1" :inactive-value="0"
          active-text="启用" inactive-text="禁用"
          @change="toggleEnabled"
        />
        <span v-if="saveStatus" class="save-hint"
          :style="{ color: saveStatus === 'saved' ? '#67c23a' : '#909399' }">
          {{ saveStatus === 'saving' ? '保存中…' : '✓ 已保存' }}
        </span>
      </div>

      <el-alert
        v-if="isRunning"
        type="warning"
        show-icon
        :closable="false"
        title="任务运行中，请先停止任务后再修改配置"
        style="margin:8px 0 12px"
      />

      <el-form :model="form" label-width="100px" :disabled="isRunning">
        <el-form-item label="绑定账号">
          <el-select v-model="form.account_id" placeholder="请选择账号" filterable style="width:100%">
            <el-option v-for="a in allAccounts" :key="a.id" :label="a.mobile" :value="a.id">
              <span>{{ a.mobile }}</span>
              <span style="float:right;color:#909399;font-size:12px">
                {{ a.account_type === 'wechat' ? '微信' : 'App' }}
              </span>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="目标医生">
          <el-select v-model="form.doctor_code" filterable allow-create default-first-option
            clearable placeholder="搜索医生姓名/编码" style="width:100%">
            <el-option v-for="d in doctors" :key="d.doctor_code"
              :label="`${d.doctor_name || d.doctor_code}  (${d.doctor_code})`"
              :value="d.doctor_code">
              <span style="font-weight:500">{{ d.doctor_name || d.doctor_code }}</span>
              <span style="float:right;color:#909399;font-size:12px;margin-left:8px">{{ d.doctor_code }}</span>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="目标日期">
          <el-date-picker v-model="form.lock_plan_date" type="date" value-format="YYYY-MM-DD"
            placeholder="锁号目标日期" style="width:100%" clearable />
        </el-form-item>

        <el-form-item label="就诊人">
          <el-select v-model="form.patient_id" clearable placeholder="默认取第一个就诊人" style="width:100%"
            :loading="patientsLoading">
            <el-option label="自动（第一个就诊人）" value="" />
            <el-option v-for="p in accountPatients" :key="p.id"
              :label="`${p.name}  ${p.gender || ''}  ${p.age != null ? p.age + '岁' : ''}`"
              :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>

      <div class="cfg-tip">
        <el-icon><InfoFilled /></el-icon>
        <span>查号窗口、锁号、通道等差异化配置已下沉到代理层，请在该任务下的代理行（⚙）或代理池中配置</span>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" :disabled="isRunning" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { InfoFilled } from '@element-plus/icons-vue'
import TaskStatusBadge from './TaskStatusBadge.vue'
import { getTask, updateTask, setTaskEnabled, getDoctors, getAccounts, getAccountPatients, getTaskStatus } from '@/api'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  taskId:     { type: Number, default: null },
})
const emit = defineEmits(['update:modelValue', 'saved', 'closed'])

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const loading = ref(false)
const task = ref(null)
const allAccounts = ref([])
const doctors = ref([])
const accountPatients = ref([])
const patientsLoading = ref(false)
const runtimeStatus = reactive({ status: 'idle' })
const saveStatus = ref('') // '' | 'saving' | 'saved'

const form = reactive({
  account_id: null,
  doctor_code: '',
  lock_plan_date: '',
  patient_id: '',
})

const isRunning = computed(() =>
  ['running', 'initializing'].includes(runtimeStatus.status)
)

watch(() => props.modelValue, async (v) => {
  if (v && props.taskId != null) await load()
  if (!v) reset()
})

watch(() => form.account_id, async (newId) => {
  if (newId) await loadPatients(newId)
})

async function load() {
  loading.value = true
  try {
    const [t, accts, dr, st] = await Promise.all([
      getTask(props.taskId),
      getAccounts(),
      getDoctors(),
      getTaskStatus(props.taskId).catch(() => ({ data: { status: 'idle' } })),
    ])
    task.value = t.data
    allAccounts.value = accts.data
    doctors.value = dr.data
    runtimeStatus.status = st.data?.status || 'idle'
    Object.assign(form, {
      account_id:     t.data.account_id,
      doctor_code:    t.data.doctor_code || '',
      lock_plan_date: t.data.lock_plan_date || '',
      patient_id:     t.data.patient_id || '',
    })
    if (form.account_id) await loadPatients(form.account_id)
  } finally {
    loading.value = false
  }
}

async function loadPatients(accountId) {
  patientsLoading.value = true
  try {
    const r = await getAccountPatients(accountId)
    accountPatients.value = r.data || []
  } finally {
    patientsLoading.value = false
  }
}

function reset() {
  task.value = null
  Object.assign(form, { account_id: null, doctor_code: '', lock_plan_date: '', patient_id: '' })
  saveStatus.value = ''
}

async function toggleEnabled() {
  if (!task.value) return
  try {
    await setTaskEnabled(task.value.id, task.value.enabled === 1)
    ElMessage.success(task.value.enabled === 1 ? '已启用' : '已禁用')
  } catch {
    task.value.enabled = task.value.enabled === 1 ? 0 : 1
  }
}

async function save() {
  if (!task.value) return
  saveStatus.value = 'saving'
  try {
    await updateTask(task.value.id, {
      account_id: form.account_id,
      doctor_code: form.doctor_code || null,
      lock_plan_date: form.lock_plan_date || null,
      patient_id: form.patient_id || null,
    })
    saveStatus.value = 'saved'
    ElMessage.success('已保存')
    emit('saved')
    setTimeout(() => { saveStatus.value = '' }, 1500)
  } catch {
    saveStatus.value = ''
  }
}

function onClose() {
  emit('closed')
}
</script>

<style scoped>
.cfg-topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.save-hint {
  margin-left: auto;
  font-size: 12px;
}
.cfg-tip {
  margin-top: 12px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 4px;
  color: #909399;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
