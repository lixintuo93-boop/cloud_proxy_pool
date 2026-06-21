# 挂号查票系统 v2

## 新增功能

### 1. 支持两种查号模式

#### 配置切换（config.js）
```javascript
// checkMode: 'doctor' - 按医生查号（使用 source.doctor.plans.hsr）
// checkMode: 'dept'   - 按部门查号（使用 source.dept.plans.hsr）
checkMode: 'doctor',
```

### 2. 按部门查号模式

新增接口 `mobile-web/source.dept.plans.hsr`，可以查询某个部门某天的所有号源。

#### 配置参数
```javascript
deptQueryParams: {
  deptCode: "110901",           // 部门代码（肿瘤门诊）
  planDateStart: "2025-12-30",  // 开始日期
  planDateEnd: "2025-12-30",    // 结束日期
  hospitalId: "10097"
},

// 号源类型选择
// 'expert' - 仅从专家号(ZJ001)中选择
// 'topic'  - 仅从专题号(ZT001)中选择  
// 'normal' - 仅从普通号(PT001)中选择
// 'all'    - 从所有类型中选择
deptTicketType: 'expert',
```

#### 返回数据结构
```json
{
  "code": 0,
  "value": [
    {
      "registerTypeCode": "ZJ001",
      "registerTypeName": "专家号",
      "doctorList": [
        {
          "doctorCode": "LWP",
          "doctorName": "卢雯平",
          "deptName": "肿瘤门诊",
          "planList": [
            {
              "id": "xxx",
              "remainNum": 10,
              "fee": "800",
              ...
            }
          ]
        }
      ]
    },
    {
      "registerTypeCode": "ZT001",
      "registerTypeName": "专题号",
      ...
    },
    {
      "registerTypeCode": "PT001", 
      "registerTypeName": "普通号",
      ...
    }
  ]
}
```

### 3. 动态医生列表（从数据库读取）

按医生查号时，可以从数据库动态读取当天出诊的医生列表。

#### 配置
```javascript
// doctorSource: 'config'   - 使用配置文件中的 doctorCodes
// doctorSource: 'database' - 从数据库动态读取当天出诊医生
doctorSource: 'database',
```

#### 数据库配置
```javascript
database: {
  // ... 其他配置
  doctorDbPath: 'E:/gamyy_base_info/doctors.db',
}
```

#### 数据库表结构

**doctors 表**
```sql
CREATE TABLE doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  title TEXT,
  doctor_code TEXT UNIQUE,
  priority INTEGER DEFAULT 1
)
```

**schedule 表**
```sql
CREATE TABLE schedule (
  doctor_code TEXT PRIMARY KEY,
  monday TEXT,      -- '1' 表示出诊
  tuesday TEXT,
  wednesday TEXT,
  thursday TEXT,
  friday TEXT,
  saturday TEXT,
  sunday TEXT,
  FOREIGN KEY (doctor_code) REFERENCES doctors (doctor_code)
)
```

#### 工作逻辑
1. 程序启动时获取当前星期几
2. 查询 schedule 表中对应字段值为 '1' 的医生
3. 使用这些医生代码进行查号

---

## 文件变更

| 文件 | 变更说明 |
|------|----------|
| `config/config.js` | 新增 checkMode、doctorSource、deptQueryParams、deptTicketType 配置 |
| `database/doctorDb.js` | 新增，用于读取医生排班数据库 |
| `services/ticketService.js` | 支持两种查号模式，动态医生列表 |

---

## 使用示例

### 按医生查号（从数据库读取医生）
```javascript
// config.js
checkMode: 'doctor',
doctorSource: 'database',
```

### 按医生查号（使用配置文件）
```javascript
// config.js
checkMode: 'doctor',
doctorSource: 'config',
queryParams: {
  doctorCodes: ["LWP","LIUH","SWG","LDR"],
  planDateStart: "2025-12-30",
  hospitalId: "10097"
},
```

### 按部门查号（仅专家号）
```javascript
// config.js
checkMode: 'dept',
deptQueryParams: {
  deptCode: "110901",
  planDateStart: "2025-12-30",
  planDateEnd: "2025-12-30",
  hospitalId: "10097"
},
deptTicketType: 'expert',
```

---

## 统一通道说明

本版本同时保留了之前的"统一通道"改动：
- 不再区分查号通道和锁号通道
- 所有通道可以同时用于查号和锁号
- 通过 requestType 验证防止请求类型误判
