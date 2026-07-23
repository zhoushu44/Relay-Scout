#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""基于 wzdnzd/aggregator socks-checker.py 的 Cloudflare 目标质量检测扩展。

原项目采用 Apache License 2.0。本文件为修改/扩展实现：增加重复请求、
Cloudflare 挑战页识别、成功率与终端表格汇总。
"""

import argparse
import asyncio
import importlib.util
import statistics
import sys
import time
import json
from pathlib import Path
from typing import Optional

import aiohttp
from aiohttp_socks import ProxyConnector


CHALLENGE_MARKERS = (
    "challenge-platform",
    "cf-chl-",
    "cf_chl_",
    "just a moment...",
    "attention required! | cloudflare",
    "verify you are human",
    "enable javascript and cookies to continue",
)


def load_upstream():
    source = Path(__file__).with_name("socks-checker.py")
    spec = importlib.util.spec_from_file_location("upstream_socks_checker", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载上游检测器: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


UPSTREAM = load_upstream()


def build_session(proxy_info):
    protocol = (proxy_info.protocol or "socks5").lower()
    if protocol not in ("socks5", "socks5h"):
        raise ValueError(f"仅支持 SOCKS5，当前为 {protocol}")

    auth = ""
    if proxy_info.username or proxy_info.password:
        from urllib.parse import quote

        username = quote(proxy_info.username or "", safe="")
        password = quote(proxy_info.password or "", safe="")
        auth = f"{username}:{password}@"
    proxy_url = f"socks5://{auth}{proxy_info.host}:{proxy_info.port}"
    return aiohttp.ClientSession(connector=ProxyConnector.from_url(proxy_url))


def classify_response(status: int, body: str, url: str) -> tuple[bool, str]:
    if status in (403, 429, 503):
        return False, f"HTTP {status}"
    lowered = body.lower()
    if any(marker in lowered for marker in CHALLENGE_MARKERS):
        return False, "CF挑战页"
    if 200 <= status < 400:
        return True, "成功"
    return False, f"HTTP {status}"


async def get_exit_ip(session: aiohttp.ClientSession, timeout: int) -> Optional[str]:
    try:
        async with session.get("https://www.cloudflare.com/cdn-cgi/trace", timeout=aiohttp.ClientTimeout(total=timeout)) as response:
            if response.status != 200:
                return None
            text = await response.text()
            for line in text.splitlines():
                if line.startswith("ip="):
                    return line[3:].strip()
    except Exception:
        return None
    return None


async def reputation(session: aiohttp.ClientSession, ip: Optional[str], timeout: int) -> dict:
    if not ip:
        return {"status": "unknown", "reason": "出口 IP 不可用"}
    try:
        async with session.get(f"http://ip-api.com/json/{ip}?fields=status,countryCode,proxy,hosting,mobile", timeout=aiohttp.ClientTimeout(total=min(timeout, 5))) as response:
            if response.status != 200:
                return {"status": "unknown", "reason": f"信誉服务 HTTP {response.status}"}
            data = await response.json(content_type=None)
            if data.get("status") != "success":
                return {"status": "unknown", "reason": "信誉服务未返回结果"}
            return {"status": "suspicious" if data.get("proxy") or data.get("hosting") else "clean", "proxy": bool(data.get("proxy")), "vpn": bool(data.get("hosting")), "residential": not bool(data.get("proxy") or data.get("hosting")), "country_code": data.get("countryCode")}
    except Exception as exc:
        return {"status": "unknown", "reason": type(exc).__name__}


async def check_one(proxy_info, url: str, attempts: int, timeout: int, threshold: float, max_latency: float):
    successes = 0
    latencies = []
    errors: dict[str, int] = {}
    exit_ips = []
    reputation_result = {"status": "unknown", "reason": "未查询"}

    try:
        async with build_session(proxy_info) as session:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Cache-Control": "no-cache",
            }
            for _ in range(attempts):
                started = time.perf_counter()
                try:
                    async with session.get(
                        url,
                        headers=headers,
                        timeout=aiohttp.ClientTimeout(total=timeout),
                        allow_redirects=True,
                    ) as response:
                        body = await response.text(errors="replace")
                        ok, reason = classify_response(response.status, body, url)
                        exit_ip = next((line[3:].strip() for line in body.splitlines() if line.startswith("ip=")), None)
                        if exit_ip:
                            exit_ips.append(exit_ip)
                        if ok and exit_ip:
                            successes += 1
                            latencies.append((time.perf_counter() - started) * 1000)
                        else:
                            errors[reason if not ok else "出口 IP 不可用"] = errors.get(reason if not ok else "出口 IP 不可用", 0) + 1
                except asyncio.TimeoutError:
                    errors["超时"] = errors.get("超时", 0) + 1
                except Exception as exc:
                    reason = type(exc).__name__
                    errors[reason] = errors.get(reason, 0) + 1
            if exit_ips:
                reputation_result = await reputation(session, exit_ips[0], timeout)
    except Exception as exc:
        errors[type(exc).__name__] = attempts

    rate = successes / attempts * 100
    avg_latency = statistics.fmean(latencies) if latencies else None
    stable = bool(exit_ips) and len(set(exit_ips)) == 1
    main_error = max(errors, key=errors.get) if errors else "-"
    qualified = bool(exit_ips) and stable and rate >= threshold and avg_latency is not None and avg_latency <= max_latency
    country_code = reputation_result.get("country_code")
    region = "domestic" if country_code in {"CN", "CHN"} else "foreign" if country_code else "unknown"
    return {
        "proxy": proxy_info.original,
        "successes": successes,
        "attempts": attempts,
        "rate": rate,
        "qualified": qualified,
        "latency": avg_latency,
        "exit_ip": exit_ips[0] if exit_ips else "-",
        "region": region,
        "exit_ip_stable": stable,
        "reputation": reputation_result,
        "timeout_rate": errors.get("超时", 0) / attempts * 100,
        "error": main_error,
    }


async def run(args) -> int:
    checker = UPSTREAM.ProxyChecker(
        timeout=args.timeout,
        format_pattern=args.input_format or None,
    )
    proxies = UPSTREAM.read_proxies(args.file)
    proxy_infos = []
    seen = set()
    for text in proxies:
        info = checker.parse_proxy(text, args.input_format)
        if not info:
            continue
        key = (info.host.lower(), info.port, info.username, info.password)
        if key not in seen:
            seen.add(key)
            proxy_infos.append(info)

    if not proxy_infos:
        print("没有找到有效的 SOCKS5 代理")
        return 1

    semaphore = asyncio.Semaphore(args.concurrent)

    async def limited(info):
        async with semaphore:
            return await check_one(info, args.url, args.attempts, args.timeout, args.threshold, args.max_latency)

    print(f"检测 {len(proxy_infos)} 个代理；每个请求 {args.attempts} 次；合格阈值 {args.threshold:.0f}%")
    results = await asyncio.gather(*(limited(info) for info in proxy_infos))
    results.sort(key=lambda item: (item["qualified"], item["rate"], -(item["latency"] or 10**9)), reverse=True)
    if args.json_output:
        Path(args.json_output).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    headers = ("结果", "SOCKS5", "CF率", "成功", "平均延迟", "出口IP", "主要失败")
    rows = []
    for item in results:
        rows.append(
            (
                "合格" if item["qualified"] else "不合格",
                item["proxy"],
                f'{item["rate"]:.0f}% ',
                f'{item["successes"]}/{item["attempts"]}',
                f'{item["latency"]:.0f}ms' if item["latency"] is not None else "-",
                item["exit_ip"],
                item["error"],
            )
        )

    widths = [len(headers[index]) for index in range(len(headers))]
    for row in rows:
        for index, value in enumerate(row):
            widths[index] = min(max(widths[index], len(str(value))), 55)

    def print_row(row):
        values = []
        for index, value in enumerate(row):
            text = str(value)
            if len(text) > widths[index]:
                text = text[: widths[index] - 3] + "..."
            values.append(text.ljust(widths[index]))
        print(" | ".join(values))

    print()
    print_row(headers)
    print("-+-".join("-" * width for width in widths))
    for row in rows:
        print_row(row)

    qualified = sum(item["qualified"] for item in results)
    average_rate = statistics.fmean(item["rate"] for item in results)
    print(f"\n总计 {len(results)} | 合格 {qualified} | 不合格 {len(results) - qualified} | 平均 CF 率 {average_rate:.1f}%")
    return 0 if qualified else 2


def main():
    parser = argparse.ArgumentParser(description="SOCKS5 Cloudflare 目标请求成功率检测")
    parser.add_argument("-f", "--file", required=True, help="代理文本，每行一个")
    parser.add_argument("-u", "--url", required=True, help="有权测试的 Cloudflare 目标 URL")
    parser.add_argument("-n", "--attempts", type=int, default=10, help="每个代理请求次数（默认 10）")
    parser.add_argument("-c", "--concurrent", type=int, default=10, help="代理并发数（默认 10）")
    parser.add_argument("-t", "--timeout", type=int, default=10, help="单次请求超时秒数（默认 10）")
    parser.add_argument("--threshold", type=float, default=90, help="合格成功率百分比（默认 90）")
    parser.add_argument("--max-latency", type=float, default=800, help="平均延迟上限毫秒（默认 800）")
    parser.add_argument("--input-format", help='自定义格式，如 "{host}:{port}:{username}:{password}"')
    parser.add_argument("--json-output", help="将检测结果写入 JSON 文件")
    args = parser.parse_args()
    if args.attempts < 1 or args.concurrent < 1 or args.timeout < 1:
        parser.error("attempts、concurrent 和 timeout 必须大于 0")
    if not 0 <= args.threshold <= 100:
        parser.error("threshold 必须在 0 到 100 之间")
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
