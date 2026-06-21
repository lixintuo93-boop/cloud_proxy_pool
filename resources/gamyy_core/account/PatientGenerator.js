'use strict';

const SURNAMES = [
  '王','李','张','刘','陈','杨','黄','赵','吴','周',
  '徐','孙','马','朱','胡','郭','何','高','林','郑',
  '谢','罗','梁','宋','唐','许','韩','冯','邓','曹',
  '彭','曾','肖','田','董','袁','潘','于','蒋','蔡',
  '余','杜','叶','程','苏','魏','吕','丁','任','沈',
  '姚','卢','姜','崔','钟','谭','陆','汪','范','金',
  '石','廖','贾','夏','韦','付','方','白','邹','孟',
  '熊','秦','邱','江','尹','薛','闫','段','雷','侯',
  '龙','史','陶','黎','贺','顾','毛','郝','龚','邵',
];

const MALE_CHARS = [
  '伟','磊','强','洋','勇','军','杰','涛','明','超',
  '刚','斌','成','波','阳','博','峰','志','浩','瑞',
  '辉','康','鹏','宇','晨','航','泽','睿','轩','文',
  '铭','俊','翔','昊','天','浩','飞','翼','建','国',
  '庆','兴','发','春','永','海','山','广','正','清',
];

const FEMALE_CHARS = [
  '梅','雪','云','娟','萍','玉','燕','莉','颖','怡',
  '美','芬','婷','蓉','琳','晶','倩','丹','红','兰',
  '敏','静','丽','秀','芳','月','玲','馨','琪','洁',
  '佳','雨','欣','思','露','茜','诗','珊','菲','慧',
  '惠','瑜','蕊','悦','雯','钰','凤','娥','真','韵',
];

const REGION_CODES = [
  '110101','110102','110105','110106','110107','110108',
  '310101','310104','310105','310106','310107','310109',
  '440103','440104','440105','440106','440111','440112',
  '330102','330103','330104','330105','330106','330108',
  '210102','210103','210104','210105','210111','210112',
  '420102','420103','420104','420105','420106','420107',
  '510104','510105','510106','510107','510108','510112',
  '320102','320104','320105','320106','320111','320113',
  '120101','120102','120103','120104','120105','120106',
  '500101','500102','500103','500104','500105','500106',
  '610102','610103','610104','610111','610112','610113',
  '370102','370103','370104','370105','370112','370113',
  '130102','130104','130105','130107','130108','130109',
  '230102','230103','230104','230108','230109','230110',
];

const CHECK_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CHARS   = ['1','0','X','9','8','7','6','5','4','3','2'];

function _rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _pick(arr) {
  return arr[_rand(0, arr.length - 1)];
}

function _calcCheck(first17) {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += parseInt(first17[i], 10) * CHECK_WEIGHTS[i];
  return CHECK_CHARS[sum % 11];
}

function generateName(gender) {
  const surname = _pick(SURNAMES);
  const pool    = gender === 'female' ? FEMALE_CHARS : MALE_CHARS;
  const len     = Math.random() < 0.4 ? 2 : 1;
  let given     = _pick(pool);
  if (len === 2) given += _pick(pool);
  return surname + given;
}

function generateIdCard(minAge, maxAge, gender) {
  const region  = _pick(REGION_CODES);
  const today   = new Date();
  const maxYear = today.getFullYear() - minAge;
  const minYear = today.getFullYear() - maxAge;
  const year    = _rand(minYear, maxYear);
  const month   = _rand(1, 12);
  const maxDay  = new Date(year, month, 0).getDate();
  const day     = _rand(1, maxDay);
  const bday    = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;

  let seq;
  do { seq = _rand(1, 999); }
  while (gender === 'male' ? seq % 2 === 0 : seq % 2 !== 0);

  const first17 = region + bday + String(seq).padStart(3, '0');
  return first17 + _calcCheck(first17);
}

/**
 * Parse birthday and gender from an 18-digit ID card number.
 * Returns null if the input is invalid.
 */
function parseIdCard(idNumber) {
  if (!idNumber || idNumber.length !== 18) return null;
  const year    = idNumber.substring(6, 10);
  const month   = idNumber.substring(10, 12);
  const day     = idNumber.substring(12, 14);
  const seq     = parseInt(idNumber.substring(14, 17), 10);
  const gender  = seq % 2 !== 0 ? 'male' : 'female';
  return {
    birthday:    `${year}-${month}-${day}`,
    birthdayRaw: `${year}${month}${day}`,
    gender,
    genderCN:    gender === 'male' ? '男' : '女',
    sexCode:     gender === 'male' ? '1' : '2',
  };
}

/**
 * Generate a complete patient info object ready for PatientBind + CreatePatient.
 *
 * @param {{ minAge?: number, maxAge?: number }} opts
 * @returns {{ name, idNo, birthday, birthdayRaw, sex, genderCN }}
 */
function generatePatientInfo(opts = {}) {
  const minAge = Math.max(1, opts.minAge ?? 18);
  const maxAge = Math.max(minAge, opts.maxAge ?? 60);
  const gender = opts.gender === 'male' || opts.gender === 'female'
    ? opts.gender
    : (Math.random() < 0.5 ? 'male' : 'female');

  const idNo   = generateIdCard(minAge, maxAge, gender);
  const parsed = parseIdCard(idNo);
  const name   = generateName(gender);

  return {
    name,
    idNo,
    birthday:    parsed.birthday,      // YYYY-MM-DD  → PatientBind
    birthdayRaw: parsed.birthdayRaw,   // YYYYMMDD    → CreatePatient
    sex:         parsed.sexCode,       // '1'/'2'     → PatientBind
    genderCN:    parsed.genderCN,      // '男'/'女'   → CreatePatient
  };
}

module.exports = { generatePatientInfo, generateIdCard, generateName, parseIdCard };
