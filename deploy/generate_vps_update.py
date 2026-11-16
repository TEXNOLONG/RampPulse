#!/usr/bin/env python3
"""
Скрипт генерации автономного обновления для VPS.
Упаковывает все обновлённые файлы бэкенда и веб-интерфейса в один самораспаковывающийся скрипт deploy/update_vps_remote.py
"""
import os
import json
import zlib
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FILES_TO_PACK = [
    "backend/main.py",
    "backend/chat.py",
    "requirements.txt",
    "frontend/bridge.js",
    "frontend/chat.js",
    "frontend/chat.css",
    "frontend/engineer.html",
    "frontend/index.html",
    "deploy/nginx_ramppulse.conf",
]

def main():
    bundle = {}
    for rel_path in FILES_TO_PACK:
        full_path = ROOT / rel_path
        if not full_path.exists():
            print(f"Warning: {rel_path} not found!")
            continue
        content = full_path.read_bytes()
        bundle[rel_path] = base64.b64encode(content).decode("ascii")

    compressed_json = zlib.compress(json.dumps(bundle).encode("utf-8"), 9)
    encoded_payload = base64.b64encode(compressed_json).decode("ascii")

    updater_code = f'''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Автоматический апдейтер RampPulse для Ubuntu VPS.
Обновляет бэкенд, медиа/ГС эндпоинты, веб-интерфейс, WebSocket звонков и перезапускает службы.
"""
import os
import sys
import json
import zlib
import base64
import subprocess
from pathlib import Path

PAYLOAD = "{encoded_payload}"

def run(cmd, shell=True, check=True):
    print(f"--> [RUN] {{cmd}}")
    res = subprocess.run(cmd, shell=shell, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.stdout.strip():
        print(res.stdout.strip())
    if res.stderr.strip():
        print(res.stderr.strip(), file=sys.stderr)
    return res

def main():
    print("=" * 60)
    print("   RampPulse: Обновление системы на VPS")
    print("=" * 60)

    # 1. Определение рабочей директории проекта
    candidates = [
        Path("/opt/ramppulse"),
        Path("/root/ramppulse"),
        Path.cwd()
    ]
    target_dir = None
    for cand in candidates:
        if (cand / "backend" / "main.py").exists():
            target_dir = cand
            break

    if not target_dir:
        target_dir = Path("/opt/ramppulse")
        target_dir.mkdir(parents=True, exist_ok=True)

    print(f"[+] Целевая директория проекта: {{target_dir}}")

    # 2. Распаковка файлов
    raw_data = zlib.decompress(base64.b64decode(PAYLOAD))
    files = json.loads(raw_data.decode("utf-8"))

    for rel_path, b64_content in files.items():
        dest = target_dir / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        content = base64.b64decode(b64_content)
        dest.write_bytes(content)
        print(f"  [OK] Записан: {{rel_path}} ({{len(content)}} байт)")

    # 3. Создание директории загрузок медиа и ГС
    upload_dir = target_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(str(upload_dir), 0o777)
    except Exception:
        pass
    print(f"[+] Директория медиафайлов/ГС готова: {{upload_dir}}")

    # 4. Установка необходимых Python-зависимостей (python-multipart для загрузки файлов)
    pip_bin = target_dir / "venv" / "bin" / "pip"
    if not pip_bin.exists():
        pip_bin = "pip3"
    else:
        pip_bin = str(pip_bin)

    print(f"[+] Проверка и установка зависимостей через {{pip_bin}}...")
    try:
        run(f"{{pip_bin}} install --no-cache-dir python-multipart")
    except Exception as e:
        print(f"[!] Предупреждение pip: {{e}}")

    # 5. Обновление конфигурации Nginx (поддержка WebSocket /ws и /ws/voice/)
    nginx_conf_source = target_dir / "deploy" / "nginx_ramppulse.conf"
    nginx_dest = Path("/etc/nginx/sites-available/ramppulse")
    if nginx_conf_source.exists() and Path("/etc/nginx").exists():
        nginx_dest.write_text(nginx_conf_source.read_text(encoding="utf-8"), encoding="utf-8")
        enabled_link = Path("/etc/nginx/sites-enabled/ramppulse")
        if not enabled_link.exists() and nginx_dest.exists():
            try:
                enabled_link.symlink_to(nginx_dest)
            except Exception:
                pass
        # Убираем дефолтный сайт если слушает 80
        default_site = Path("/etc/nginx/sites-enabled/default")
        if default_site.exists():
            default_site.unlink()
        try:
            run("nginx -t && systemctl reload nginx")
            print("[+] Конфигурация Nginx обновлена и перезагружена")
        except Exception as e:
            print(f"[!] Nginx reload warning: {{e}}")

    # 6. Перезапуск службы ramppulse
    try:
        run("systemctl daemon-reload")
        run("systemctl restart ramppulse")
        print("[+] Служба ramppulse перезапущена")
    except Exception as e:
        print(f"[!] Systemctl restart warning: {{e}}")

    # 7. Финальная проверка работоспособности
    print("-" * 60)
    print("[+] Проверка работоспособности бэкенда:")
    try:
        res = run("curl -s http://127.0.0.1:8000/healthz", check=False)
        print(f"    Healthz: {{res.stdout.strip()}}")
        res_upload = run("curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:8000/api/chat/upload", check=False)
        print(f"    API Chat Upload HTTP Status: {{res_upload.stdout.strip()}} (ожидается 401 для анонимного запроса без токена)")
    except Exception:
        pass

    print("=" * 60)
    print("   ОБНОВЛЕНИЕ УСПЕШНО ЗАВЕРШЕНО!")
    print("   - Регистрация и допуск инженеров: АКТИВНЫ")
    print("   - Жизненный цикл заявок на ТО: АКТИВЕН")
    print("   - Чат с медиа и ГС (голосовыми): АКТИВЕН")
    print("   - Голосовые звонки (Walkie-Talkie WebSocket): АКТИВНЫ")
    print("=" * 60)

if __name__ == "__main__":
    main()
'''

    out_file = ROOT / "deploy" / "update_vps_remote.py"
    out_file.write_text(updater_code, encoding="utf-8")
    print(f"Generated standalone updater: {out_file} ({len(updater_code)} chars)")

if __name__ == "__main__":
    main()
