"""
Запуск нативного приложения RampPulse на Windows.
Использование:
  python run_native.py
  python run_native.py http://IP_ВАШЕГО_VPS
"""
import sys
from native_app.app import main

if __name__ == "__main__":
    main()
