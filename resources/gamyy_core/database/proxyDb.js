// database/proxyDb.js
const sqlite3 = require('sqlite3').verbose();


class ProxyDatabase {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.proxyType = this.config.proxy?.proxyType || 'ssh-tunnel';
    
    // 根据代理类型获取配置
    let dbPath, platform, groups;
    
    if (this.proxyType === 'ssh-tunnel') {
      dbPath = this.config.proxy?.sshTunnel?.dbPath;
      groups = this.config.proxy?.sshTunnel?.groups;
      platform = null;
    } else if (this.proxyType === 'standard') {
      dbPath = this.config.proxy?.standard?.dbPath;
      platform = this.config.proxy?.standard?.platform;
      groups = this.config.proxy?.standard?.groups;
      
      if (!platform) {
        throw new Error('标准代理模式必须指定 platform 参数');
      }
    } else {
      throw new Error(`不支持的代理类型: ${this.proxyType}`);
    }
    
    // 处理分组配置（支持数组或单个字符串）
    if (Array.isArray(groups)) {
      this.proxyGroups = groups.filter(g => g);  // 过滤空值
    } else if (groups) {
      this.proxyGroups = [groups];  // 单个字符串转数组
    } else {
      this.proxyGroups = [];
    }
    
    // 保存平台信息（仅标准代理使用）
    this.platform = platform;
    
    // 初始化数据库连接
    if (!dbPath) {
      throw new Error(`代理类型 ${this.proxyType} 缺少数据库路径配置`);
    }
    
    this.db = new sqlite3.Database(dbPath);
    
    // 输出初始化信息
    if (this.proxyType === 'ssh-tunnel') {
      if (this.proxyGroups.length > 0) {
        console.log(`📡 使用SSH隧道代理模式 [组: ${this.proxyGroups.join(', ')}]`);
      } else {
        console.log('📡 使用SSH隧道代理模式 [全部代理]');
      }
    } else if (this.proxyType === 'standard') {
      if (this.proxyGroups.length > 0) {
        console.log(`📡 使用标准代理模式 [平台: ${this.platform}, 组: ${this.proxyGroups.join(', ')}]`);
      } else {
        console.log(`📡 使用标准代理模式 [平台: ${this.platform}, 全部分组]`);
      }
    }
  }

  /**
   * 获取可用代理列表（根据代理类型自动选择）
   */
  async getAvailableProxies() {
    if (this.proxyType === 'standard') {
      return this.getStandardProxies();
    }
    return this.getSshTunnelProxies();
  }

  /**
   * 获取SSH隧道代理（原阿里云代理逻辑）
   */
  async getSshTunnelProxies() {
    return new Promise((resolve, reject) => {
      // 关联查询ssh_servers表，获取真实代理IP
      // 如果配置了组，则只获取对应组的代理
      let query;
      let params = [];
      
      if (this.proxyGroups.length > 0) {
        // 使用IN语句支持多组查询
        const placeholders = this.proxyGroups.map(() => '?').join(', ');
        query = `
          SELECT 
            p.host, 
            p.port,
            s.server_host as realProxyIp,
            p.group_name
          FROM proxies p
          LEFT JOIN ssh_servers s ON p.ssh_server_id = s.id
          WHERE p.group_name IN (${placeholders})
          ORDER BY p.created_time DESC
        `;
        params = this.proxyGroups;
      } else {
        query = `
          SELECT 
            p.host, 
            p.port,
            s.server_host as realProxyIp,
            p.group_name
          FROM proxies p
          LEFT JOIN ssh_servers s ON p.ssh_server_id = s.id
          ORDER BY p.created_time DESC
        `;
      }
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          // 标记代理类型
          const proxies = (rows || []).map(row => ({
            ...row,
            proxyType: 'ssh-tunnel',
            username: null,
            password: null
          }));
          
          if (this.proxyGroups.length > 0) {
            console.log(`📡 SSH隧道代理 [组: ${this.proxyGroups.join(', ')}]: 共加载 ${proxies.length} 个代理`);
          } else {
            console.log(`📡 SSH隧道代理: 共加载 ${proxies.length} 个代理`);
          }
          
          resolve(proxies);
        }
      });
    });
  }

  /**
   * 获取标准代理（使用新的代理管理系统）
   */
  async getStandardProxies() {
    return new Promise((resolve, reject) => {
      // 查询未过期、工作正常的代理，按平台和分组筛选
      let query;
      let params = [];
      
      // 构建WHERE条件
      const whereConditions = [
        'is_working = 1'  // 只获取工作正常的代理
      ];
      
      // 添加平台筛选（必填）
      whereConditions.push('platform = ?');
      params.push(this.platform);
      
      // 添加分组筛选（可选）
      if (this.proxyGroups.length > 0) {
        const placeholders = this.proxyGroups.map(() => '?').join(', ');
        whereConditions.push(`group_name IN (${placeholders})`);
        params.push(...this.proxyGroups);
      }
      
      query = `
        SELECT 
          id,
          ip as host,
          port,
          username,
          password,
          country,
          city,
          platform,
          group_name,
          real_ip as realProxyIp,
          expire_time
        FROM proxies
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY id ASC
      `;
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          // 标记代理类型
          const proxies = (rows || []).map(row => {
            return {
              ...row,
              proxyType: 'standard'
            };
          });
          
          // 输出日志
          if (this.proxyGroups.length > 0) {
            console.log(`📡 标准代理 [平台: ${this.platform}, 组: ${this.proxyGroups.join(', ')}]: 共加载 ${proxies.length} 个工作正常的代理`);
          } else {
            console.log(`📡 标准代理 [平台: ${this.platform}, 全部分组]: 共加载 ${proxies.length} 个工作正常的代理`);
          }
          
          resolve(proxies);
        }
      });
    });
  }

  /**
   * 根据端口获取真实代理IP（仅SSH隧道代理使用）
   */
  async getRealProxyIpByPort(port) {
    if (this.proxyType === 'standard') {
      // 标准代理直接返回null，因为realProxyIp就是ip本身
      return null;
    }
    
    return new Promise((resolve, reject) => {
      const query = `
        SELECT s.server_host as realProxyIp
        FROM proxies p
        LEFT JOIN ssh_servers s ON p.ssh_server_id = s.id
        WHERE p.port = ?
      `;
      
      this.db.get(query, [port], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.realProxyIp : null);
        }
      });
    });
  }

  /**
   * 批量获取端口对应的真实代理IP映射（仅SSH隧道代理使用）
   */
  async getRealProxyIpMap() {
    if (this.proxyType === 'standard') {
      // 标准代理返回空Map
      return new Map();
    }
    
    return new Promise((resolve, reject) => {
      const query = `
        SELECT 
          p.port,
          s.server_host as realProxyIp
        FROM proxies p
        LEFT JOIN ssh_servers s ON p.ssh_server_id = s.id
      `;
      
      this.db.all(query, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const map = new Map();
          (rows || []).forEach(row => {
            map.set(row.port, row.realProxyIp);
          });
          resolve(map);
        }
      });
    });
  }

  /**
   * 获取当前代理类型
   */
  getProxyType() {
    return this.proxyType;
  }

  /**
   * 关闭数据库连接
   */
  close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            console.error(`⚠️ 关闭代理数据库时出错:`, err.message);
          }
          this.db = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = ProxyDatabase;
