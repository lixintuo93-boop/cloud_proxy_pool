<template>
  <MainLayout>
    <div class="viewer-wrap">
      <iframe src="/channel-viewer.html" class="viewer-frame" />
    </div>
  </MainLayout>
</template>

<script setup>
import MainLayout from '@/layout/MainLayout.vue'
</script>

<style scoped>
/* 抵消 el-main 的 16px 20px padding，让 iframe 贴边铺满 */
.viewer-wrap {
  margin: -16px -20px;
  height: calc(100vh - 52px);
  overflow: hidden;
}

.viewer-frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
