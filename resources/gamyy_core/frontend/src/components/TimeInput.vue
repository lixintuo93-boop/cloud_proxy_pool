<!-- 时间输入：HH:MM:SS.mmm  v-model 绑定字符串 -->
<template>
  <div class="time-input">
    <el-input v-model="hh" maxlength="2" placeholder="HH" @change="emit" class="seg" />
    <span class="sep">:</span>
    <el-input v-model="mm" maxlength="2" placeholder="MM" @change="emit" class="seg" />
    <span class="sep">:</span>
    <el-input v-model="ss" maxlength="2" placeholder="SS" @change="emit" class="seg" />
    <span class="sep">.</span>
    <el-input v-model="ms" maxlength="3" placeholder="mmm" @change="emit" class="seg ms" />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({ modelValue: String })
const emits = defineEmits(['update:modelValue'])

const hh = ref(''), mm = ref(''), ss = ref(''), ms = ref('')

function parse(v) {
  if (!v) { hh.value = mm.value = ss.value = ms.value = ''; return }
  const m = v.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/)
  if (m) { hh.value = m[1]; mm.value = m[2]; ss.value = m[3]; ms.value = m[4] }
}

function emit() {
  const v = `${pad2(hh.value)}:${pad2(mm.value)}:${pad2(ss.value)}.${pad3(ms.value)}`
  emits('update:modelValue', v)
}

function pad2(s) { return String(s || '0').padStart(2, '0') }
function pad3(s) { return String(s || '0').padStart(3, '0') }

watch(() => props.modelValue, parse, { immediate: true })
</script>

<style scoped>
.time-input { display: flex; align-items: center; gap: 4px; }
.seg { width: 52px; }
.seg.ms { width: 62px; }
.sep { color: #606266; font-size: 16px; font-weight: 600; }
</style>
