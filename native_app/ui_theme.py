"""
Современная тёмная тема в авиационном стиле (Glass/Avionics Dark Theme).
Полностью нативный рендеринг через Qt6 без браузерных движков.
"""

DARK_THEME_QSS = """
QMainWindow, QDialog {
    background-color: #0A0E17;
    color: #E2E8F0;
    font-family: "Segoe UI", -apple-system, sans-serif;
}

QWidget {
    font-family: "Segoe UI", -apple-system, sans-serif;
    color: #E2E8F0;
}

QTabWidget::pane {
    border: 1px solid #1E293B;
    background-color: #0F172A;
    border-radius: 8px;
    top: -1px;
}

QTabBar::tab {
    background: #0B1120;
    color: #94A3B8;
    padding: 10px 20px;
    margin-right: 4px;
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    font-weight: 600;
    font-size: 13px;
    border: 1px solid transparent;
}

QTabBar::tab:selected {
    background: #0F172A;
    color: #38BDF8;
    border: 1px solid #1E293B;
    border-bottom: 2px solid #38BDF8;
}

QTabBar::tab:hover:!selected {
    background: #1E293B;
    color: #F1F5F9;
}

QGroupBox {
    background-color: #0F172A;
    border: 1px solid #1E293B;
    border-radius: 8px;
    margin-top: 24px;
    padding: 14px;
    font-weight: bold;
    font-size: 13px;
    color: #38BDF8;
}

QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    left: 14px;
    padding: 2px 8px;
    background-color: #1E293B;
    border-radius: 4px;
}

QPushButton {
    background-color: #1E293B;
    color: #F8FAFC;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
}

QPushButton:hover {
    background-color: #334155;
    border-color: #38BDF8;
}

QPushButton:pressed {
    background-color: #0284C7;
    border-color: #38BDF8;
}

QPushButton:disabled {
    background-color: #0B1120;
    color: #475569;
    border-color: #1E293B;
}

QPushButton.primary-btn {
    background-color: #0284C7;
    border: 1px solid #38BDF8;
    color: #FFFFFF;
}

QPushButton.primary-btn:hover {
    background-color: #0369A1;
}

QPushButton.success-btn {
    background-color: #059669;
    border: 1px solid #10B981;
    color: #FFFFFF;
}

QPushButton.success-btn:hover {
    background-color: #047857;
}

QPushButton.danger-btn {
    background-color: #DC2626;
    border: 1px solid #EF4444;
    color: #FFFFFF;
}

QPushButton.danger-btn:hover {
    background-color: #B91C1C;
}

QLineEdit, QTextEdit, QPlainTextEdit {
    background-color: #0B1120;
    border: 1px solid #1E293B;
    border-radius: 6px;
    padding: 8px 12px;
    color: #F8FAFC;
    selection-background-color: #0284C7;
    selection-color: #FFFFFF;
    font-size: 13px;
}

QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {
    border: 1px solid #38BDF8;
}

QTableWidget, QTreeWidget, QListWidget {
    background-color: #0B1120;
    border: 1px solid #1E293B;
    border-radius: 6px;
    gridline-color: #1E293B;
    color: #E2E8F0;
    font-size: 12px;
    selection-background-color: #1E293B;
    selection-color: #38BDF8;
}

QHeaderView::section {
    background-color: #0F172A;
    color: #94A3B8;
    padding: 8px;
    border: none;
    border-bottom: 1px solid #1E293B;
    font-weight: 600;
    font-size: 12px;
}

QScrollBar:vertical {
    background: #0B1120;
    width: 10px;
    margin: 0px;
    border-radius: 5px;
}

QScrollBar::handle:vertical {
    background: #334155;
    min-height: 20px;
    border-radius: 5px;
}

QScrollBar::handle:vertical:hover {
    background: #475569;
}

QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0px;
}

QScrollBar:horizontal {
    background: #0B1120;
    height: 10px;
    margin: 0px;
    border-radius: 5px;
}

QScrollBar::handle:horizontal {
    background: #334155;
    min-width: 20px;
    border-radius: 5px;
}

QScrollBar::handle:horizontal:hover {
    background: #475569;
}

QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
    height: 0px;
}

QComboBox {
    background-color: #1E293B;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 6px 12px;
    color: #F8FAFC;
    min-width: 120px;
    font-size: 12px;
    font-weight: 600;
}

QComboBox:hover {
    border-color: #38BDF8;
}

QComboBox::drop-down {
    border: none;
    width: 24px;
}

QComboBox QAbstractItemView {
    background-color: #0F172A;
    border: 1px solid #334155;
    selection-background-color: #1E293B;
    selection-color: #38BDF8;
    color: #F8FAFC;
    padding: 4px;
}

QLabel {
    color: #E2E8F0;
}

QProgressBar {
    border: 1px solid #1E293B;
    border-radius: 4px;
    text-align: center;
    background-color: #0B1120;
    color: #FFFFFF;
    font-size: 11px;
    font-weight: 600;
}

QProgressBar::chunk {
    background-color: #059669;
    border-radius: 3px;
}
"""
