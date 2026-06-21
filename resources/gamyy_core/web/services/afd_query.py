#!/usr/bin/env python3
"""
百度 AFD IP 威胁情报查询 - 独立脚本
用法: python afd_query.py <ip> [proxy_url]
     proxy_url 格式: http://user:pass@host:port
输出: JSON 到 stdout
"""
import sys
import json
import asyncio
import random
import time
import urllib.parse

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1366, "height": 768},
    {"width": 1536, "height": 864},
]

BAIDU_URL = "https://cloud.baidu.com/product-s/afd_s/ip-threat.html"


def _parse_api_response(data, target_ip=None):
    result = {"risk_level": None, "location": None, "isp": None, "scene": None}
    if not isinstance(data, dict):
        return result

    # 路径一：百度 AFD ret_data.data.* 专用解析
    ret_data = data.get("ret_data")
    if isinstance(ret_data, dict) and ret_data.get("code") == 200:
        d = ret_data.get("data", {})
        if isinstance(d, dict):
            parts = [d.get("country"), d.get("province"), d.get("city")]
            loc = "/".join(p for p in parts if p)
            if loc:
                result["location"] = loc
            if d.get("isp"):
                result["isp"] = d["isp"]
            if d.get("scene"):
                result["scene"] = d["scene"]
            overall = d.get("overall")
            if isinstance(overall, dict):
                risk = overall.get("risk_score_new") or overall.get("risk_score")
                if risk:
                    result["risk_level"] = risk
        if any(result.get(k) for k in result):
            return result

    # 路径二：通用展平匹配
    flat = {}
    def flatten(obj, prefix=""):
        if isinstance(obj, dict):
            for k, v in obj.items():
                flatten(v, f"{prefix}{k}.")
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                flatten(v, f"{prefix}{i}.")
        else:
            flat[prefix.rstrip(".")] = obj
    flatten(data)

    def pick(keys):
        for k in keys:
            for fk, fv in flat.items():
                if fk.lower().endswith(k.lower()) and fv:
                    return str(fv)
        return None

    result["risk_level"] = pick(["risk_score_new", "risk_score", "riskLevel", "risk_level", "riskGrade", "threatLevel"])
    result["location"]   = pick(["location", "region", "province", "address", "areaName"])
    result["isp"]        = pick(["isp", "operator", "carrier", "ispName", "networkOperator"])
    result["scene"]      = pick(["scene", "scenario", "ipType", "ip_type", "networkType", "usageType", "lineType"])
    return result


async def _extract_from_dom(page):
    result = {"risk_level": None, "location": None, "isp": None, "scene": None}
    try:
        data = await page.evaluate("""
            () => {
                const labelMap = {
                    '风险等级': 'risk_level',
                    '归属地':   'location',
                    '运营商':   'isp',
                    '应用场景': 'scene'
                };
                const found = {};
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
                let node;
                while ((node = walker.nextNode())) {
                    const raw = (node.innerText || node.textContent || '').trim();
                    if (labelMap[raw]) {
                        const key = labelMap[raw];
                        let val = null;
                        let sib = node.nextElementSibling;
                        if (sib) val = (sib.innerText || sib.textContent || '').trim();
                        if (!val) {
                            sib = node.previousElementSibling;
                            if (sib) val = (sib.innerText || sib.textContent || '').trim();
                        }
                        if (!val && node.parentElement) {
                            const kids = Array.from(node.parentElement.children);
                            const i = kids.indexOf(node);
                            if (i > 0) val = (kids[i-1].innerText || kids[i-1].textContent || '').trim();
                            if (!val && i < kids.length - 1) val = (kids[i+1].innerText || kids[i+1].textContent || '').trim();
                        }
                        if (val && val !== raw) found[key] = val;
                    }
                }
                return found;
            }
        """)
        if data:
            result.update(data)
    except Exception:
        pass
    return result


async def query_afd(target_ip, proxy_url=None):
    result = {"risk_level": None, "location": None, "isp": None, "scene": None, "error": None}

    if not PLAYWRIGHT_AVAILABLE:
        result["error"] = "Playwright 未安装，请运行: pip install playwright && playwright install chromium"
        return result

    playwright_proxy = None
    if proxy_url:
        try:
            p = urllib.parse.urlparse(proxy_url)
            if p.scheme in ('socks5', 'socks4', 'socks'):
                playwright_proxy = {"server": f"socks5://{p.hostname}:{p.port}"}
                if p.username:
                    playwright_proxy["username"] = urllib.parse.unquote(p.username)
                if p.password:
                    playwright_proxy["password"] = urllib.parse.unquote(p.password)
            else:
                playwright_proxy = {
                    "server":   f"http://{p.hostname}:{p.port}",
                    "username": urllib.parse.unquote(p.username or ""),
                    "password": urllib.parse.unquote(p.password or ""),
                }
        except Exception:
            pass  # 降级为直连

    api_responses = []
    fingerprint = {
        "user_agent": random.choice(USER_AGENTS),
        "viewport":   random.choice(VIEWPORTS),
    }
    timestamp = int(time.time() * 1000)
    url = f"{BAIDU_URL}?s={target_ip}&t={timestamp}"

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                ]
            )
            try:
                ctx_kwargs = dict(
                    user_agent=fingerprint["user_agent"],
                    viewport=fingerprint["viewport"],
                    locale="zh-CN",
                    timezone_id="Asia/Shanghai",
                )
                if playwright_proxy:
                    ctx_kwargs["proxy"] = playwright_proxy

                context = await browser.new_context(**ctx_kwargs)
                await context.add_init_script("""
                    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                    Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
                    window.chrome = {runtime: {}};
                """)
                page = await context.new_page()

                async def on_response(resp):
                    try:
                        ct = resp.headers.get("content-type", "")
                        if "json" in ct and resp.status == 200:
                            try:
                                data = await resp.json()
                                api_responses.append(data)
                            except Exception:
                                pass
                    except Exception:
                        pass

                page.on("response", on_response)

                page_ok = True
                try:
                    await page.goto(url, wait_until="networkidle", timeout=35000)
                except Exception:
                    page_ok = False

                try:
                    content = await page.content()
                except Exception:
                    content = ""

                if "cf-challenge" in content or "Just a moment" in content:
                    result["error"] = "访问被Cloudflare拦截"
                    return result

                await asyncio.sleep(random.uniform(1.5, 3.0) if not page_ok else random.uniform(2.5, 4.0))

                # 路径一：DOM 解析
                dom_result = await _extract_from_dom(page)
                if any(dom_result.get(k) for k in ["risk_level", "location", "isp", "scene"]):
                    result.update(dom_result)
                    return result

                # 路径二：API 响应解析
                merged = {"risk_level": None, "location": None, "isp": None, "scene": None}
                for api_data in api_responses:
                    parsed = _parse_api_response(api_data, target_ip)
                    for k in merged:
                        if not merged[k] and parsed.get(k):
                            merged[k] = parsed[k]
                if any(merged.get(k) for k in merged):
                    result.update(merged)
                    return result

                result["error"] = "页面已加载但未找到风险数据" if page_ok else "networkidle超时且未能提取数据"

            finally:
                await browser.close()

    except Exception as e:
        result["error"] = str(e)

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python afd_query.py <ip> [proxy_url]"}))
        sys.exit(1)

    ip = sys.argv[1]
    proxy = sys.argv[2] if len(sys.argv) > 2 else None
    r = asyncio.run(query_afd(ip, proxy))
    print(json.dumps(r, ensure_ascii=False))
