<template>
  <el-tag :type="tagType" size="small" effect="dark">{{ label }}</el-tag>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: String,
  enabled: { type: Number, default: 1 },
  stopReason: { type: String, default: null },
})

const map = {
  running:      { type: 'success', label: '运行中' },
  initializing: { type: '',        label: '初始化' },
  stopping:     { type: 'warning', label: '停止中' },
  error:        { type: 'danger',  label: '错误'   },
  idle:         { type: 'info',    label: '已停止' },
}

const reasonMap = {
  lock_success:            { type: 'success', label: '锁号成功' },
  already_booked:          { type: 'warning', label: '账号已挂号' },
  lock_window_expired:     { type: 'info',    label: '锁号窗口结束' },
  check_window_expired:    { type: 'info',    label: '查票窗口结束' },
  global_fallback_timeout: { type: 'info',    label: '兜底超时' },
  cloud_agent_stopped:     { type: 'info',    label: '云端结束' },
  manual:                  { type: 'info',    label: '手动停止' },
}

const tagType = computed(() => {
  if (props.enabled === 0) return 'warning'
  if (props.status === 'idle' && props.stopReason && reasonMap[props.stopReason]) {
    return reasonMap[props.stopReason].type
  }
  return map[props.status]?.type ?? 'info'
})

const label = computed(() => {
  if (props.enabled === 0) return '已禁用'
  if (props.status === 'idle' && props.stopReason && reasonMap[props.stopReason]) {
    return reasonMap[props.stopReason].label
  }
  return map[props.status]?.label ?? '未知'
})
</script>
