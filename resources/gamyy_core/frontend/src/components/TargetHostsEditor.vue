<template>
  <div>
    <div v-if="!systemHosts || !systemHosts.length" style="color:#909399;font-size:12px;padding:2px 0">
      系统配置中未设置目标主机，请先前往系统配置添加。
    </div>
    <template v-else>
      <div v-for="(h, i) in systemHosts" :key="i" style="margin-bottom:8px">
        <el-checkbox :model-value="isSelected(h)" @change="toggle(h)">
          <span style="font-family:monospace;font-size:13px">{{ h.host }}:{{ h.port }}</span>
          <span v-if="h.sni" style="color:#909399;font-size:12px;margin-left:8px">SNI: {{ h.sni }}</span>
        </el-checkbox>
      </div>
      <p v-if="!modelValue || !modelValue.length" style="color:#909399;font-size:12px;margin:4px 0 0">
        全不选 = 继承上级配置
      </p>
    </template>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue:  { type: Array, default: () => [] },
  systemHosts: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])

function key(h) { return `${h.host}:${h.port}` }
function isSelected(h) { return (props.modelValue || []).some(x => key(x) === key(h)) }

function toggle(h) {
  const k = key(h)
  if (isSelected(h)) {
    emit('update:modelValue', (props.modelValue || []).filter(x => key(x) !== k))
  } else {
    emit('update:modelValue', [...(props.modelValue || []), { ...h }])
  }
}
</script>
