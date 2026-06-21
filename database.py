# database.py
"""
数据库管理模块 v3.8
- 增加代理分组功能
"""
import sqlite3
from config import DATABASE_FILE, get_beijing_time_str


class ProxyDatabase:
    def __init__(self, db_file=None):
        """初始化数据库"""
        self.db_file = db_file if db_file else DATABASE_FILE
        self.init_database()

    def init_database(self):
        """初始化数据库"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        # SSH服务器表
        cursor.execute('''
                       CREATE TABLE IF NOT EXISTS ssh_servers
                       (
                           id
                           INTEGER
                           PRIMARY
                           KEY
                           AUTOINCREMENT,
                           name
                           TEXT
                           NOT
                           NULL,
                           server_host
                           TEXT
                           NOT
                           NULL
                           UNIQUE,
                           server_port
                           INTEGER
                           DEFAULT
                           22,
                           username
                           TEXT
                           NOT
                           NULL,
                           password
                           TEXT
                           NOT
                           NULL,
                           created_time
                           TIMESTAMP
                           DEFAULT
                           CURRENT_TIMESTAMP
                       )
                       ''')

        # 本地代理表
        cursor.execute('''
                       CREATE TABLE IF NOT EXISTS proxies
                       (
                           id
                           INTEGER
                           PRIMARY
                           KEY
                           AUTOINCREMENT,
                           ssh_server_id
                           INTEGER,
                           name
                           TEXT
                           NOT
                           NULL,
                           host
                           TEXT
                           DEFAULT
                           '127.0.0.1',
                           port
                           INTEGER
                           NOT
                           NULL
                           UNIQUE,
                           is_active
                           INTEGER
                           DEFAULT
                           0,
                           last_check
                           TIMESTAMP
                           DEFAULT
                           CURRENT_TIMESTAMP,
                           created_time
                           TIMESTAMP
                           DEFAULT
                           CURRENT_TIMESTAMP,
                           group_name
                           TEXT
                           DEFAULT
                           '1',
                           FOREIGN
                           KEY
                       (
                           ssh_server_id
                       ) REFERENCES ssh_servers
                       (
                           id
                       )
                           )
                       ''')

        # 检查并添加group_name列（兼容旧数据库）
        cursor.execute("PRAGMA table_info(proxies)")
        columns = [col[1] for col in cursor.fetchall()]
        if 'group_name' not in columns:
            cursor.execute("ALTER TABLE proxies ADD COLUMN group_name TEXT DEFAULT '1'")

        # 配置表（存储运行时配置）
        cursor.execute('''
                       CREATE TABLE IF NOT EXISTS config
                       (
                           key
                           TEXT
                           PRIMARY
                           KEY,
                           value
                           TEXT,
                           updated_time
                           TIMESTAMP
                           DEFAULT
                           CURRENT_TIMESTAMP
                       )
                       ''')

        # 性能优化：WAL 模式允许读写并发；NORMAL 同步减少 fsync 次数
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")

        # 高频查询索引
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_proxies_is_active ON proxies(is_active)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_proxies_port ON proxies(port)")

        # 幂等迁移：ssh_servers 加 cloud_provider 字段（'auto' 待探测、'aliyun'/'tencent'/'default'）
        try:
            cursor.execute("SELECT cloud_provider FROM ssh_servers LIMIT 1")
        except sqlite3.OperationalError:
            cursor.execute("ALTER TABLE ssh_servers ADD COLUMN cloud_provider TEXT NOT NULL DEFAULT 'auto'")

        # 幂等迁移：ssh_servers 加 last_deploy_status 字段（'never' / 'success' / 'failed'）
        try:
            cursor.execute("SELECT last_deploy_status FROM ssh_servers LIMIT 1")
        except sqlite3.OperationalError:
            cursor.execute("ALTER TABLE ssh_servers ADD COLUMN last_deploy_status TEXT NOT NULL DEFAULT 'never'")

        # 幂等迁移：ssh_servers 加 deploy_mode 字段（'agent' / 'full'）
        try:
            cursor.execute("SELECT deploy_mode FROM ssh_servers LIMIT 1")
        except sqlite3.OperationalError:
            cursor.execute("ALTER TABLE ssh_servers ADD COLUMN deploy_mode TEXT NOT NULL DEFAULT 'agent'")

        conn.commit()
        conn.close()

    def add_ssh_server(self, name, server_host, username, password, server_port=22, cloud_provider='auto'):
        """添加SSH服务器

        Args:
            cloud_provider: 'auto'（部署时探测）/ 'aliyun' / 'tencent' / 'default'
        """
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        try:
            cursor.execute('SELECT id FROM ssh_servers WHERE server_host = ?', (server_host,))
            if cursor.fetchone():
                conn.close()
                return None, "SSH服务器已存在"

            cursor.execute('''
                           INSERT INTO ssh_servers (name, server_host, server_port, username, password, cloud_provider)
                           VALUES (?, ?, ?, ?, ?, ?)
                           ''', (name, server_host, server_port, username, password, cloud_provider))

            conn.commit()
            server_id = cursor.lastrowid
            conn.close()
            return server_id, "SSH服务器添加成功"

        except sqlite3.IntegrityError as e:
            conn.close()
            return None, f"数据库错误: {str(e)}"
        except Exception as e:
            conn.close()
            return None, f"添加失败: {str(e)}"

    def update_server_cloud_provider(self, server_id, cloud_provider):
        """更新服务器的 cloud_provider（部署时探测出 'aliyun'/'tencent'/'default' 后写回）"""
        try:
            conn = sqlite3.connect(self.db_file, timeout=10)
            cur = conn.cursor()
            cur.execute('UPDATE ssh_servers SET cloud_provider = ? WHERE id = ?', (cloud_provider, server_id))
            conn.commit()
            conn.close()
            return cur.rowcount > 0
        except Exception:
            return False

    def update_server_deploy_status(self, server_id, status):
        """更新服务器的最近一次部署状态（'success' / 'failed' / 'never'）"""
        try:
            conn = sqlite3.connect(self.db_file, timeout=10)
            cur = conn.cursor()
            cur.execute('UPDATE ssh_servers SET last_deploy_status = ? WHERE id = ?', (status, server_id))
            conn.commit()
            conn.close()
            return cur.rowcount > 0
        except Exception:
            return False

    def update_server_deploy_mode(self, server_id, mode):
        """更新服务器的部署模式（'agent' / 'full'）"""
        try:
            conn = sqlite3.connect(self.db_file, timeout=10)
            cur = conn.cursor()
            cur.execute('UPDATE ssh_servers SET deploy_mode = ? WHERE id = ?', (mode, server_id))
            conn.commit()
            conn.close()
            return cur.rowcount > 0
        except Exception:
            return False

    def add_local_proxy(self, ssh_server_id, name, port, host='127.0.0.1', group_name='1'):
        """添加本地代理"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        try:
            cursor.execute('SELECT id FROM proxies WHERE port = ?', (port,))
            if cursor.fetchone():
                conn.close()
                return None, "本地端口已被使用"

            cursor.execute('''
                           INSERT INTO proxies (ssh_server_id, name, host, port, group_name)
                           VALUES (?, ?, ?, ?, ?)
                           ''', (ssh_server_id, name, host, port, group_name))

            conn.commit()
            proxy_id = cursor.lastrowid
            conn.close()
            return proxy_id, "本地代理添加成功"

        except Exception as e:
            conn.close()
            return None, f"添加失败: {str(e)}"

    def get_next_available_port(self):
        """获取下一个可用端口"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('SELECT MAX(port) FROM proxies')
        max_port = cursor.fetchone()[0]
        conn.close()

        if max_port is None:
            return 5001  # 默认起始端口

        return max_port + 1

    def get_used_ports(self):
        """获取所有已使用的端口"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()
        cursor.execute('SELECT port FROM proxies ORDER BY port')
        used_ports = set(row[0] for row in cursor.fetchall())
        conn.close()
        return used_ports

    def is_server_exists(self, server_host):
        """检查SSH服务器是否已存在"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('SELECT id FROM ssh_servers WHERE server_host = ?', (server_host,))
        exists = cursor.fetchone() is not None
        conn.close()
        return exists

    def is_port_used(self, port):
        """检查端口是否已被使用"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('SELECT id FROM proxies WHERE port = ?', (port,))
        used = cursor.fetchone() is not None
        conn.close()
        return used

    def get_proxy_details(self, proxy_id):
        """获取代理的完整信息（包括SSH服务器信息）"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('''
                       SELECT lp.id,
                              lp.name,
                              lp.host,
                              lp.port,
                              lp.is_active,
                              lp.last_check,
                              ss.id as server_id,
                              ss.server_host,
                              ss.server_port,
                              ss.username,
                              ss.password,
                              lp.group_name
                       FROM proxies lp
                                JOIN ssh_servers ss ON lp.ssh_server_id = ss.id
                       WHERE lp.id = ?
                       ''', (proxy_id,))

        result = cursor.fetchone()
        conn.close()

        if result:
            return {
                'proxy_id': result[0],
                'proxy_name': result[1],
                'host': result[2],
                'port': result[3],
                'is_active': result[4],
                'last_check': result[5],
                'server_id': result[6],
                'server_host': result[7],
                'server_port': result[8],
                'username': result[9],
                'password': result[10],
                'group_name': result[11] or '1'
            }
        return None

    def get_all_proxies_with_details(self):
        """获取所有代理的完整信息

        Tuple 索引：
            0..12 同前；13 cloud_provider；14 last_deploy_status
        """
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('''
                       SELECT lp.id,
                              lp.name as proxy_name,
                              lp.host,
                              lp.port,
                              lp.is_active,
                              lp.last_check,
                              ss.id   as server_id,
                              ss.name as server_name,
                              ss.server_host,
                              ss.server_port,
                              ss.username,
                              ss.password,
                              lp.group_name,
                              ss.cloud_provider,
                              ss.last_deploy_status
                       FROM proxies lp
                                JOIN ssh_servers ss ON lp.ssh_server_id = ss.id
                       ORDER BY lp.port
                       ''')

        proxies = cursor.fetchall()
        conn.close()
        return proxies

    def get_active_proxies_with_details(self):
        """获取活跃代理的完整信息"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('''
                       SELECT lp.id,
                              lp.name as proxy_name,
                              lp.host,
                              lp.port,
                              lp.is_active,
                              lp.last_check,
                              ss.id   as server_id,
                              ss.name as server_name,
                              ss.server_host,
                              ss.server_port,
                              ss.username,
                              ss.password,
                              lp.group_name,
                              ss.cloud_provider,
                              ss.last_deploy_status
                       FROM proxies lp
                                JOIN ssh_servers ss ON lp.ssh_server_id = ss.id
                       WHERE lp.is_active = 1
                       ORDER BY lp.port
                       ''')

        proxies = cursor.fetchall()
        conn.close()
        return proxies

    def update_proxy_status(self, proxy_id, is_active):
        """更新代理状态（使用北京时间）"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        beijing_time = get_beijing_time_str()

        cursor.execute('''
                       UPDATE proxies
                       SET is_active  = ?,
                           last_check = ?
                       WHERE id = ?
                       ''', (1 if is_active else 0, beijing_time, proxy_id))

        conn.commit()
        conn.close()

    def update_proxy_port(self, proxy_id, new_port):
        """更新代理的本地端口（用于运行时端口被外部占用后的自动迁移）。

        Returns:
            bool: 是否更新成功
        """
        try:
            conn = sqlite3.connect(self.db_file, timeout=10)
            cursor = conn.cursor()
            cursor.execute('UPDATE proxies SET port = ? WHERE id = ?', (new_port, proxy_id))
            updated = cursor.rowcount
            conn.commit()
            conn.close()
            return updated > 0
        except Exception:
            return False

    def batch_update_proxy_status(self, updates):
        """批量更新代理状态（一次事务，适合批量状态变更场景）
        updates: list of (proxy_id, is_active)
        """
        if not updates:
            return
        beijing_time = get_beijing_time_str()
        conn = sqlite3.connect(self.db_file, timeout=10)
        try:
            conn.executemany(
                "UPDATE proxies SET is_active=?, last_check=? WHERE id=?",
                [(1 if a else 0, beijing_time, pid) for pid, a in updates]
            )
            conn.commit()
        finally:
            conn.close()

    def cleanup_old_status(self):
        """WAL 检查点：将 WAL 文件合并回主库，防止 WAL 文件无限增长"""
        conn = sqlite3.connect(self.db_file, timeout=10)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()

    def delete_proxy(self, proxy_id):
        """删除代理（保留SSH服务器）"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('DELETE FROM proxies WHERE id = ?', (proxy_id,))

        conn.commit()
        conn.close()

    def get_all_groups(self):
        """获取所有组名"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('''
                       SELECT DISTINCT group_name
                       FROM proxies
                       WHERE group_name IS NOT NULL
                         AND group_name != ''
                       ORDER BY group_name
                       ''')

        groups = [row[0] for row in cursor.fetchall()]
        conn.close()

        # 确保至少有默认组 '1'
        if '1' not in groups:
            groups.insert(0, '1')

        return groups

    def update_proxy_group(self, proxy_id, group_name):
        """更新单个代理的组"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        try:
            cursor.execute('''
                           UPDATE proxies
                           SET group_name = ?
                           WHERE id = ?
                           ''', (group_name, proxy_id))
            conn.commit()
            return True
        except Exception as e:
            conn.rollback()
            return False
        finally:
            conn.close()

    def update_proxies_group(self, proxy_ids, group_name):
        """批量更新代理的组"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        try:
            placeholders = ','.join(['?' for _ in proxy_ids])
            cursor.execute(f'''
                UPDATE proxies SET group_name = ? WHERE id IN ({placeholders})
            ''', [group_name] + list(proxy_ids))
            conn.commit()
            return True
        except Exception as e:
            conn.rollback()
            return False
        finally:
            conn.close()

    def delete_server_and_proxies(self, server_id):
        """删除SSH服务器及其所有代理"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        try:
            cursor.execute('DELETE FROM proxies WHERE ssh_server_id = ?', (server_id,))
            cursor.execute('DELETE FROM ssh_servers WHERE id = ?', (server_id,))

            conn.commit()
            conn.close()
            return True, "服务器及相关代理已删除"
        except Exception as e:
            conn.rollback()
            conn.close()
            return False, f"删除失败: {str(e)}"

    def delete_all_servers_and_proxies(self):
        """删除所有服务器和代理"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        try:
            cursor.execute('DELETE FROM proxies')
            cursor.execute('DELETE FROM ssh_servers')

            conn.commit()
            conn.close()
            return True, "所有服务器和代理已删除"
        except Exception as e:
            conn.rollback()
            conn.close()
            return False, f"删除失败: {str(e)}"

    def save_config(self, key, value):
        """保存配置到数据库"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        beijing_time = get_beijing_time_str()

        cursor.execute('''
            INSERT OR REPLACE INTO config (key, value, updated_time)
            VALUES (?, ?, ?)
        ''', (key, str(value), beijing_time))

        conn.commit()
        conn.close()

    def get_config(self, key, default=None):
        """从数据库获取配置"""
        conn = sqlite3.connect(self.db_file)
        cursor = conn.cursor()

        cursor.execute('SELECT value FROM config WHERE key = ?', (key,))
        result = cursor.fetchone()
        conn.close()

        if result:
            return result[0]
        return default