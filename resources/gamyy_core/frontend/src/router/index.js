import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/',              redirect: '/accounts' },
  { path: '/accounts',      name: 'Accounts',     component: () => import('@/views/Accounts.vue') },
{ path: '/templates',     name: 'Templates',    component: () => import('@/views/Templates.vue') },
  { path: '/logs',          name: 'Logs',         component: () => import('@/views/Logs.vue') },
  { path: '/system-config', name: 'SystemConfig', component: () => import('@/views/SystemConfig.vue') },
  { path: '/proxy-pool',   name: 'ProxyPool',    component: () => import('@/views/ProxyPool.vue') },
]

export default createRouter({
  history: createWebHistory(),
  routes,
})
