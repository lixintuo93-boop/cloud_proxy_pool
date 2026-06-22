// debug_proxy_config.js - 调试代理配置
const config = require('./config/config');
const ProxyDatabase = require('./database/proxyDb');

async function debugProxyConfig() {
  console.log('=== 调试代理配置 ===\n');
  
  // 1. 检查配置
  console.log('1️⃣ 当前配置：');
  console.log('   代理类型:', config.proxy?.proxyType);
  console.log('   平台:', config.proxy?.standard?.platform);
  console.log('   分组:', config.proxy?.standard?.groups);
  console.log('   数据库路径:', config.proxy?.standard?.dbPath);
  console.log('');
  
  // 2. 加载代理
  console.log('2️⃣ 从数据库加载代理：');
  const proxyDb = new ProxyDatabase();
  
  try {
    const proxies = await proxyDb.getAvailableProxies();
    console.log(`   共加载 ${proxies.length} 个代理\n`);
    
    if (proxies.length > 0) {
      console.log('3️⃣ 代理详细信息（前3个）：');
      proxies.slice(0, 3).forEach((proxy, i) => {
        console.log(`\n   代理 ${i + 1}:`);
        console.log('   - host:', proxy.host);
        console.log('   - port:', proxy.port);
        console.log('   - username:', proxy.username ? '✅ 有' : '❌ 无');
        console.log('   - password:', proxy.password ? '✅ 有' : '❌ 无');
        console.log('   - proxyType:', proxy.proxyType);
        console.log('   - platform:', proxy.platform);
        console.log('   - group_name:', proxy.group_name);
        
        // 检查username和password的实际值
        if (proxy.username) {
          console.log('   - username值:', proxy.username.substring(0, 3) + '***');
        }
        if (proxy.password) {
          console.log('   - password值:', proxy.password.substring(0, 3) + '***');
        }
      });
      
      console.log('\n4️⃣ 生成SOCKS配置：');
      const ProxyManager = require('./utils/proxyManager');
      const proxyManager = new ProxyManager();
      proxyManager.setProxies(proxies);
      
      const configs = proxyManager.getAllProxyConfigs();
      configs.slice(0, 3).forEach((cfg, i) => {
        console.log(`\n   配置 ${i + 1}:`);
        console.log('   - host:', cfg.host);
        console.log('   - port:', cfg.port);
        console.log('   - type:', cfg.type);
        console.log('   - userId:', cfg.userId ? '✅ 有' : '❌ 无');
        console.log('   - password:', cfg.password ? '✅ 有' : '❌ 无');
        console.log('   - proxyType:', cfg.proxyType);
        
        if (cfg.userId) {
          console.log('   - userId值:', cfg.userId.substring(0, 3) + '***');
        }
        if (cfg.password) {
          console.log('   - password值:', cfg.password.substring(0, 3) + '***');
        }
      });
    } else {
      console.log('   ⚠️ 没有加载到任何代理！');
      console.log('\n可能的原因：');
      console.log('   1. 数据库中没有符合条件的代理');
      console.log('   2. 平台名称不匹配');
      console.log('   3. is_working 字段为 0');
      console.log('   4. 数据库路径错误');
    }
    
  } catch (error) {
    console.error('\n❌ 错误:', error.message);
    console.error('   详情:', error);
  } finally {
    await proxyDb.close();
  }
  
  console.log('\n=== 调试完成 ===');
}

debugProxyConfig().catch(console.error);
