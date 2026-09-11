# -*- coding: utf-8 -*-
"""生成 Cloudflare Worker 上传所需的 metadata（含环境变量绑定）"""
import io
import json
import secrets
import string

cfg = json.load(io.open('config.json', encoding='utf-8'))

alpha = string.ascii_letters + string.digits
gateway_key = 'sk-luoy-' + ''.join(secrets.choice(alpha) for _ in range(32))

meta = {
    'main_module': 'index.js',
    'compatibility_date': '2026-09-01',
    'bindings': [
        {'type': 'secret_text', 'name': 'GATEWAY_KEY', 'text': gateway_key},
        {
            'type': 'secret_text',
            'name': 'PROVIDERS_JSON',
            'text': json.dumps(cfg['providers'], ensure_ascii=False),
        },
    ],
}

io.open('.worker-meta.json', 'w', encoding='utf-8', newline='').write(
    json.dumps(meta, ensure_ascii=False)
)

print('GATEWAY_KEY=' + gateway_key)
print('端点数=' + str(len(cfg['providers'])))
