# models/server.py
class Server:
    """服务器模型"""

    def __init__(self, server_id, name, server_host, server_port, username, password, created_time):
        self.server_id = server_id
        self.name = name
        self.server_host = server_host
        self.server_port = server_port
        self.username = username
        self.password = password
        self.created_time = created_time

    def to_dict(self):
        """转换为字典"""
        return {
            'server_id': self.server_id,
            'name': self.name,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'username': self.username,
            'password': self.password,
            'created_time': self.created_time
        }