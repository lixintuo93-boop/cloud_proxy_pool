// main.js - 增强版本：添加配置验证和异常处理

// 隐藏TLS相关警告
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  if (typeof warning === 'string') {
    if (warning.includes('NODE_TLS_REJECT_UNAUTHORIZED') || 
        warning.includes('TLS ServerName to an IP address')) {
      return;
    }
  }
  return originalEmitWarning.call(process, warning, ...args);
};

const SchedulerService = require('./services/SchedulerService');
const ConfigValidator = require('./config/configValidator');
const config = require('./config/config');

class TicketCheckerApp {
  constructor() {
    this.schedulerService = new SchedulerService(config);
    this.isExiting = false;
  }

  /**
   * 验证配置文件
   */
  validateConfig() {
    const validator = new ConfigValidator(config);
    return validator.printResult();
  }

  async start() {
    console.log('🏥 广安门医院抢票系统启动中...\n');
    
    // 1. 首先验证配置
    const configResult = this.validateConfig();
    // 即使有错误也继续运行（只做提示）
    
    try {
      // 2. 初始化服务
      const initResult = await this.schedulerService.initialize();
      console.log(`✅ 初始化完成: ${initResult.accounts}个账号, ${initResult.proxies}个代理\n`);
      
      // 3. 启动定时查票
      console.log('⏰ 开始定时查票...\n');
      await this.schedulerService.startScheduledCheck();
      
    } catch (error) {
      console.error('❌ 启动失败:', error.message);
      this.handleExit(1);
    }
  }

  handleExit(exitCode = 0) {
    // 防止重复退出
    if (this.isExiting) return;
    this.isExiting = true;
    
    console.log('\n🛑 正在退出...');
    
    try {
      this.schedulerService.cleanup();
      console.log('✅ 资源清理完成');
    } catch (error) {
      console.error('⚠️ 清理资源时出错:', error.message);
    }
    
    process.exit(exitCode);
  }
}

// 创建应用实例
const app = new TicketCheckerApp();

// 启动应用
app.start().catch(error => {
  console.error('❌ 未捕获的启动错误:', error);
  app.handleExit(1);
});

// ========== 优雅退出处理 ==========

// 用户中断 (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\n收到 SIGINT 信号');
  app.handleExit(0);
});

// 终止信号
process.on('SIGTERM', () => {
  console.log('\n收到 SIGTERM 信号');
  app.handleExit(0);
});

// ========== 异常处理 ==========

// 未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('\n❌ 未捕获的异常:', error.message);
  console.error(error.stack);
  app.handleExit(1);
});

// 未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ 未处理的Promise拒绝:', reason);
  // 不立即退出，只记录警告
});
