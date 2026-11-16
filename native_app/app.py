"""
Точка входа в нативное приложение RampPulse (Qt6 / PySide6).
Запуск: python -m native_app.app или python run_native.py
"""
import sys
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from .main_window import MainWindow
from .ui_theme import DARK_THEME_QSS


def main():
    # Включение High DPI масштабирования
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setApplicationName("RampPulse")
    app.setOrganizationName("RampPulse")
    app.setStyleSheet(DARK_THEME_QSS)

    server_url = "http://31.56.179.117"
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        server_url = sys.argv[1]

    window = MainWindow(default_server=server_url)
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
