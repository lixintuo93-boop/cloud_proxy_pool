<template>
  <el-container class="app-layout" direction="vertical">

    <!-- ── 顶栏 ── -->
    <el-header class="topbar">
      <!-- Logo -->
      <div class="topbar-logo">
        <el-icon size="18"><FirstAidKit /></el-icon>
        <span>广安门查票</span>
      </div>

      <!-- 导航菜单 -->
      <el-menu
        :default-active="activeMenu"
        mode="horizontal"
        router
        :ellipsis="false"
        class="topbar-nav"
        background-color="transparent"
        text-color="#606266"
        active-text-color="#409eff"
      >
        <el-menu-item index="/accounts">
          <el-icon><User /></el-icon>账号管理
        </el-menu-item>
        <el-menu-item index="/templates">
          <el-icon><Document /></el-icon>模板管理
        </el-menu-item>
        <el-menu-item index="/logs">
          <el-icon><DataLine /></el-icon>日志监控
        </el-menu-item>
        <el-menu-item index="/proxy-pool">
          <el-icon><Connection /></el-icon>代理管理
        </el-menu-item>
        <el-menu-item index="/system-config">
          <el-icon><Setting /></el-icon>系统配置
        </el-menu-item>
      </el-menu>

      <!-- 右侧状态 -->
      <div class="topbar-right">
        <span class="topbar-time">{{ currentTime }}</span>
        <el-tag v-if="wsConnected" type="success" size="small" effect="dark">● 实时</el-tag>
        <el-tag v-else type="danger" size="small" effect="dark">● 断开</el-tag>
      </div>
    </el-header>

    <!-- ── 内容区 ── -->
    <el-main class="main-content">
      <slot />
    </el-main>

  </el-container>
</template>

<script setup>
import { computed, inject, ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { User, Document, DataLine, Connection, Setting, FirstAidKit } from '@element-plus/icons-vue'

const route = useRoute()
const wsConnected = inject('wsConnected', false)

const currentTime = ref('')
let clockTimer = null
function updateClock() {
  currentTime.value = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
onMounted(() => { updateClock(); clockTimer = setInterval(updateClock, 1000) })
onUnmounted(() => clearInterval(clockTimer))

const activeMenu = computed(() => {
  if (route.path.startsWith('/tasks/')) return '/accounts'
  return route.path
})
</script>

<style scoped>
.app-layout {
  height: 100vh;
  background: #f5f7fa;
}

/* ── 顶栏 ── */
.topbar {
  height: 52px;
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 20px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
  flex-shrink: 0;
  overflow: hidden;
}

.topbar-logo {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #303133;
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
  padding-right: 20px;
  border-right: 1px solid #e4e7ed;
  margin-right: 4px;
  flex-shrink: 0;
}

/* 导航菜单撑满中间区域 */
.topbar-nav {
  flex: 1;
  border-bottom: none !important;
  height: 52px;
  min-width: 0;
}

/* 覆盖 Element Plus 水平菜单底部线 */
:deep(.el-menu--horizontal) {
  border-bottom: none !important;
}
:deep(.el-menu--horizontal > .el-menu-item) {
  height: 52px;
  line-height: 52px;
  font-size: 14px;
  padding: 0 16px;
  border-bottom: 2px solid transparent !important;
}
:deep(.el-menu--horizontal > .el-menu-item.is-active) {
  border-bottom-color: #409eff !important;
  color: #409eff !important;
  background: transparent !important;
}
:deep(.el-menu--horizontal > .el-menu-item:hover) {
  background: #f5f7fa !important;
}
:deep(.el-menu-item .el-icon) {
  margin-right: 4px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding-left: 16px;
}

.topbar-time {
  font-family: monospace;
  font-size: 13px;
  color: #909399;
  letter-spacing: .5px;
  min-width: 60px;
  text-align: right;
}

/* ── 内容区 ── */
.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  background: #f5f7fa;
}
</style>
