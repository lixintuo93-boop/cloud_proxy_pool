# models/proxy.py
class Proxy:
    """代理模型"""

    def __init__(self, proxy_id, name, host, port, is_active, last_check,
                 server_id, server_name, server_host, server_port, username, password):
        self.proxy_id = proxy_id
        self.name = name
        self.host = host
        self.port = port
        self.is_active = is_active
        self.last_check = last_check
        self.server_id = server_id
        self.server_name = server_name
        self.server_host = server_host
        self.server_port = server_port
        self.username = username
        self.password = password

    def to_dict(self):
        """转换为字典"""
        return {
            'proxy_id': self.proxy_id,
            'proxy_name': self.name,
            'host': self.host,
            'port': self.port,
            'is_active': bool(self.is_active),
            'last_check': self.last_check,
            'server_id': self.server_id,
            'server_name': self.server_name,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'username': self.username,
            'password': self.password
        }