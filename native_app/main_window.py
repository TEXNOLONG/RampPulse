"""
Главное окно нативного приложения RampPulse на Qt6.
Полностью автономный нативный GUI без браузерных движков:
- Управление сменой и заявками
- Регистрация и подтверждение допуска инженеров
- Полноценный чат с медиа (фото/файлы) и голосовыми сообщениями (ГС)
- Прямая голосовая связь (Walkie-Talkie / Звонки)
"""
import json
import os
import tempfile
import time
from typing import Any, Dict, List, Optional
from PySide6.QtCore import QDateTime, QPointF, QSettings, QSize, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QDesktopServices, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGraphicsView,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from .api_client import RampPulseClient
from .map_view import AirportMapView
from .ui_theme import DARK_THEME_QSS
from .voice_engine import VoiceEngine, VoiceNotePlayer, VoiceNoteRecorder


class MainWindow(QMainWindow):
    state_received = Signal(dict)
    chat_received = Signal(dict)
    call_signal_received = Signal(dict)

    def __init__(self, default_server: str = "http://31.56.179.117"):
        super().__init__()
        self.setWindowTitle("RampPulse · Операционный центр аэропорта")
        self.resize(1480, 920)
        self.setMinimumSize(1024, 700)

        self.settings = QSettings("RampPulse", "RampPulse")
        saved_server = self.settings.value("server_url", default_server)

        self.client = RampPulseClient(saved_server)
        self.voice = VoiceEngine(saved_server)
        self.voice_recorder = VoiceNoteRecorder(self)
        self.voice_player = VoiceNotePlayer(self)

        self.current_user: Optional[Dict[str, Any]] = None
        self.has_shown_login = False
        self.airport_data: Optional[Dict[str, Any]] = None
        self.active_room_kind = "shift"
        self.active_peer_id: Optional[int] = None
        self.active_peer_name: str = "Общий канал смены"
        self.active_call_id: Optional[str] = None
        self.call_start_time: float = 0.0

        # Состояние записи голосового сообщения
        self.is_recording_voice_note = False
        self.voice_note_timer = QTimer(self)
        self.voice_note_timer.timeout.connect(self.update_voice_note_timer)
        self.voice_note_start_time = 0.0
        self.temp_voice_file = os.path.join(tempfile.gettempdir(), "ramppulse_voice_note.wav")

        self.init_ui()
        self.setup_signals()

        # Таймер часов UTC
        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self.update_clock)
        self.clock_timer.start(1000)

        # Таймер длительности звонка
        self.call_timer = QTimer(self)
        self.call_timer.timeout.connect(self.update_call_timer)

    def init_ui(self):
        central_widget = QWidget(self)
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(12, 10, 12, 10)
        main_layout.setSpacing(10)

        # ---------- ХЕДЕР ----------
        header = QFrame(self)
        header.setStyleSheet("background-color: #0B1120; border: 1px solid #1E293B; border-radius: 8px; padding: 6px 12px;")
        h_layout = QHBoxLayout(header)
        h_layout.setContentsMargins(8, 4, 8, 4)

        title_box = QVBoxLayout()
        title_label = QLabel("RAMPPULSE · DISPATCH", self)
        title_label.setStyleSheet("font-size: 16px; font-weight: 800; color: #38BDF8; letter-spacing: 1px;")
        sub_title = QLabel("Центр оперативного управления и связи", self)
        sub_title.setStyleSheet("font-size: 11px; color: #94A3B8;")
        title_box.addWidget(title_label)
        title_box.addWidget(sub_title)
        h_layout.addLayout(title_box)

        h_layout.addSpacing(20)

        h_layout.addWidget(QLabel("Аэропорт:", self))
        self.airport_combo = QComboBox(self)
        self.airport_combo.addItems(["Шереметьево (SVO · UUEE)", "Домодедово (DME · UUDD)"])
        self.airport_combo.currentIndexChanged.connect(self.on_airport_changed)
        h_layout.addWidget(self.airport_combo)

        h_layout.addSpacing(16)

        self.vps_indicator = QLabel("● VPS: Офлайн", self)
        self.vps_indicator.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 12px;")
        h_layout.addWidget(self.vps_indicator)

        self.settings_btn = QPushButton("⚙️ Настройки и Профиль", self)
        self.settings_btn.clicked.connect(lambda: self.tabs.setCurrentWidget(self.tab_settings))
        h_layout.addWidget(self.settings_btn)

        self.login_btn = QPushButton("🔑 Сменить пользователя", self)
        self.login_btn.clicked.connect(self.open_login_dialog)
        h_layout.addWidget(self.login_btn)

        h_layout.addStretch()

        self.user_label = QLabel("Не авторизован", self)
        self.user_label.setStyleSheet("color: #EF4444; font-weight: 600; font-size: 12px;")
        h_layout.addWidget(self.user_label)

        self.clock_label = QLabel("00:00:00 UTC", self)
        self.clock_label.setStyleSheet("color: #38BDF8; font-family: monospace; font-size: 13px; font-weight: bold;")
        h_layout.addWidget(self.clock_label)

        main_layout.addWidget(header)

        # ---------- ВКЛАДКИ ПРИЛОЖЕНИЯ ----------
        self.tabs = QTabWidget(self)

        # 1. Карта перрона
        self.tab_map = QWidget()
        self.init_map_tab()
        self.tabs.addTab(self.tab_map, "Оперативная карта (2D Radar)")

        # 2. Борты и рейсы
        self.tab_flights = QWidget()
        self.init_flights_tab()
        self.tabs.addTab(self.tab_flights, "Борты и рейсы")

        # 3. Инженеры смены
        self.tab_techs = QWidget()
        self.init_techs_tab()
        self.tabs.addTab(self.tab_techs, "Инженеры смены")

        # 4. Заявки на обслуживание
        self.tab_requests = QWidget()
        self.init_requests_tab()
        self.tabs.addTab(self.tab_requests, "Заявки на обслуживание")

        # 5. Очередь регистрации (допуск инженеров)
        self.tab_registrations = QWidget()
        self.init_registrations_tab()
        self.tabs.addTab(self.tab_registrations, "Очередь допуска (Регистрация)")

        # 6. Чат, медиа и голосовая связь
        self.tab_chat = QWidget()
        self.init_chat_tab()
        self.tabs.addTab(self.tab_chat, "Связь, Чат и Рация")

        # 7. Профиль и настройки
        self.tab_settings = QWidget()
        self.init_settings_tab()
        self.tabs.addTab(self.tab_settings, "⚙️ Профиль и Настройки")

        main_layout.addWidget(self.tabs)

        self.statusBar().showMessage("Готов к работе. Подключитесь к VPS серверу.")
        self.statusBar().setStyleSheet("background-color: #070B12; color: #64748B; font-size: 11px;")

    def setup_signals(self):
        self.state_received.connect(self.on_state_received)
        self.chat_received.connect(self.on_chat_message_received)
        self.call_signal_received.connect(self.on_call_signal)

        self.client.on_state_update = lambda s: self.state_received.emit(s)
        self.client.on_chat_message = lambda m: self.chat_received.emit(m)
        self.client.on_call_signal = lambda sig: self.call_signal_received.emit(sig)
        self.client.on_connection_change = self.on_connection_change

        self.voice.call_connected.connect(self.on_voice_call_connected)
        self.voice.call_ended.connect(self.on_voice_call_ended)

    def showEvent(self, event):
        super().showEvent(event)
        if not self.has_shown_login:
            self.has_shown_login = True
            QTimer.singleShot(100, self.auto_login_or_prompt)

    def auto_login_or_prompt(self):
        saved_server = self.settings.value("server_url", "http://31.56.179.117")
        saved_email = self.settings.value("email", "dispatcher@oto.ru")
        saved_pwd = self.settings.value("password", "Dispatcher2026!")
        auto_login = self.settings.value("auto_login", True, type=bool)

        if auto_login and saved_server and saved_email and saved_pwd:
            try:
                self.connect_to_server(saved_server, saved_email, saved_pwd)
                return
            except Exception:
                pass
        self.open_login_dialog()

    # ---------- ВКЛАДКИ ----------
    def init_map_tab(self):
        layout = QVBoxLayout(self.tab_map)
        layout.setContentsMargins(6, 6, 6, 6)

        toolbar = QHBoxLayout()
        btn_fit = QPushButton("Центрировать карту", self)
        btn_fit.clicked.connect(lambda: self.map_view.fit_airport())
        toolbar.addWidget(btn_fit)

        btn_zin = QPushButton("+ Масштаб", self)
        btn_zin.clicked.connect(lambda: self.map_view.scale(1.2, 1.2))
        toolbar.addWidget(btn_zin)

        btn_zout = QPushButton("- Масштаб", self)
        btn_zout.clicked.connect(lambda: self.map_view.scale(0.8, 0.8))
        toolbar.addWidget(btn_zout)

        toolbar.addStretch()

        self.map_info_label = QLabel("ЛКМ: Перетаскивание · Колёсико: Масштаб", self)
        self.map_info_label.setStyleSheet("color: #64748B; font-size: 11px;")
        toolbar.addWidget(self.map_info_label)

        layout.addLayout(toolbar)

        self.map_view = AirportMapView(self)
        layout.addWidget(self.map_view)

    def init_flights_tab(self):
        layout = QVBoxLayout(self.tab_flights)
        layout.setContentsMargins(10, 10, 10, 10)

        btn_layout = QHBoxLayout()
        btn_new_ac = QPushButton("+ Добавить прибывающий рейс", self)
        btn_new_ac.setProperty("class", "primary-btn")
        btn_new_ac.clicked.connect(self.spawn_aircraft)
        btn_layout.addWidget(btn_new_ac)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        self.flights_table = QTableWidget(self)
        self.flights_table.setColumnCount(6)
        self.flights_table.setHorizontalHeaderLabels(["Рейс", "Стоянка", "Тип ВС", "Статус", "Норматив 15 мин", "Действие"])
        self.flights_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.flights_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.flights_table)

    def init_techs_tab(self):
        layout = QVBoxLayout(self.tab_techs)
        layout.setContentsMargins(10, 10, 10, 10)

        self.techs_table = QTableWidget(self)
        self.techs_table.setColumnCount(6)
        self.techs_table.setHorizontalHeaderLabels(["Сотрудник", "Квалификация", "Допуски ВС", "Статус", "На смене", "Связь"])
        self.techs_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.techs_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.techs_table)

    def init_requests_tab(self):
        layout = QVBoxLayout(self.tab_requests)
        layout.setContentsMargins(10, 10, 10, 10)

        btn_layout = QHBoxLayout()
        btn_new_req = QPushButton("+ Создать заявку на обслуживание", self)
        btn_new_req.setProperty("class", "primary-btn")
        btn_new_req.clicked.connect(self.open_new_request_dialog)
        btn_layout.addWidget(btn_new_req)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        self.requests_table = QTableWidget(self)
        self.requests_table.setColumnCount(7)
        self.requests_table.setHorizontalHeaderLabels(["ID", "Стоянка", "Неисправность", "Приоритет", "Техник", "Статус", "Действие"])
        self.requests_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.requests_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.requests_table)

    def init_registrations_tab(self):
        layout = QVBoxLayout(self.tab_registrations)
        layout.setContentsMargins(10, 10, 10, 10)

        toolbar = QHBoxLayout()
        btn_register_new = QPushButton("+ Зарегистрировать нового инженера", self)
        btn_register_new.setProperty("class", "primary-btn")
        btn_register_new.clicked.connect(self.open_registration_dialog)
        toolbar.addWidget(btn_register_new)

        self.pending_badge = QLabel("Ожидают проверки: 0", self)
        self.pending_badge.setStyleSheet("color: #F59E0B; font-weight: bold; font-size: 13px; margin-left: 10px;")
        toolbar.addWidget(self.pending_badge)
        toolbar.addStretch()
        layout.addLayout(toolbar)

        self.registrations_table = QTableWidget(self)
        self.registrations_table.setColumnCount(7)
        self.registrations_table.setHorizontalHeaderLabels(["ID", "ФИО инженера", "Email", "Квалификация", "База", "Допуски ВС", "Решение диспетчера"])
        self.registrations_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.registrations_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.registrations_table)

    def init_chat_tab(self):
        layout = QHBoxLayout(self.tab_chat)
        layout.setContentsMargins(8, 8, 8, 8)

        splitter = QSplitter(Qt.Orientation.Horizontal, self)

        # Левая колонка: Каналы и контакты
        left_panel = QFrame(self)
        left_panel.setStyleSheet("background-color: #0B1120; border: 1px solid #1E293B; border-radius: 8px;")
        l_layout = QVBoxLayout(left_panel)
        
        lbl_head = QLabel("💬 ЧАТ И КОНТАКТЫ", self)
        lbl_head.setStyleSheet("font-weight: bold; font-size: 13px; color: #38BDF8; margin-bottom: 4px;")
        l_layout.addWidget(lbl_head)

        # Поиск по контактам и позывным (@username)
        self.contact_search = QLineEdit(self)
        self.contact_search.setPlaceholderText("🔍 Поиск (@юзернейм, имя)...")
        self.contact_search.setStyleSheet("background-color: #0F172A; border: 1px solid #334155; border-radius: 6px; padding: 6px 10px; color: #F8FAFC;")
        self.contact_search.textChanged.connect(self.filter_contacts_list)
        l_layout.addWidget(self.contact_search)

        # Папки каналов и чатов (Telegram Folders)
        folder_layout = QHBoxLayout()
        folder_layout.setSpacing(4)
        self.btn_folder_all = QPushButton("Все", self)
        self.btn_folder_channels = QPushButton("📢 Каналы", self)
        self.btn_folder_engineers = QPushButton("🔧 ТО", self)
        self.btn_folder_dispatchers = QPushButton("👮 Дисп", self)

        self.contact_folder_filter = "all"
        self.folder_buttons_map = [
            ("all", self.btn_folder_all),
            ("channels", self.btn_folder_channels),
            ("engineers", self.btn_folder_engineers),
            ("dispatchers", self.btn_folder_dispatchers),
        ]

        def set_folder(f_name):
            self.contact_folder_filter = f_name
            for key, btn in self.folder_buttons_map:
                if key == f_name:
                    btn.setStyleSheet("background-color: #2563EB; color: white; font-weight: bold; border-radius: 4px; padding: 4px 6px; font-size: 11px;")
                else:
                    btn.setStyleSheet("background-color: #1E293B; color: #94A3B8; border: 1px solid #334155; border-radius: 4px; padding: 4px 6px; font-size: 11px;")
            self.filter_contacts_list(self.contact_search.text())

        for key, btn in self.folder_buttons_map:
            btn.clicked.connect(lambda _, k=key: set_folder(k))
            folder_layout.addWidget(btn)

        self.rooms_list = QListWidget(self)
        self.rooms_list.itemClicked.connect(self.on_room_clicked)
        l_layout.addWidget(self.rooms_list)

        set_folder("all")

        splitter.addWidget(left_panel)

        # Правая колонка: Сообщения и панель связи
        right_panel = QFrame(self)
        r_layout = QVBoxLayout(right_panel)

        # Панель вызова и поиск в переписке (Walkie-Talkie Bar)
        call_bar = QFrame(self)
        call_bar.setStyleSheet("background-color: #0F172A; border: 1px solid #1E293B; border-radius: 6px; padding: 6px;")
        cb_layout = QHBoxLayout(call_bar)

        self.chat_title_label = QLabel("📢 Общий канал смены", self)
        self.chat_title_label.setStyleSheet("font-size: 14px; font-weight: bold; color: #38BDF8;")
        cb_layout.addWidget(self.chat_title_label)

        self.chat_current_user_label = QLabel("Вы: Не авторизован", self)
        self.chat_current_user_label.setStyleSheet("color: #10B981; font-weight: bold; font-size: 11px; margin-left: 8px;")
        cb_layout.addWidget(self.chat_current_user_label)

        cb_layout.addStretch()

        # Поиск сообщений в текущей переписке
        self.msg_search_input = QLineEdit(self)
        self.msg_search_input.setPlaceholderText("🔍 Поиск в чате...")
        self.msg_search_input.setFixedWidth(160)
        self.msg_search_input.setStyleSheet("background-color: #1E293B; border: 1px solid #334155; border-radius: 6px; padding: 4px 8px; color: #F8FAFC; font-size: 11px;")
        self.msg_search_input.textChanged.connect(self.on_message_search_changed)
        cb_layout.addWidget(self.msg_search_input)

        self.call_status_label = QLabel("Связь свободна", self)
        self.call_status_label.setStyleSheet("color: #94A3B8; font-size: 12px; margin-left: 6px;")
        cb_layout.addWidget(self.call_status_label)

        self.call_btn = QPushButton("📞 Голосовой вызов", self)
        self.call_btn.setProperty("class", "success-btn")
        self.call_btn.clicked.connect(self.toggle_voice_call)
        cb_layout.addWidget(self.call_btn)

        self.mute_btn = QPushButton("🎤 Микрофон вкл", self)
        self.mute_btn.setEnabled(False)
        self.mute_btn.clicked.connect(self.toggle_mute)
        cb_layout.addWidget(self.mute_btn)

        r_layout.addWidget(call_bar)

        # Окно сообщений с кликабельными ссылками (QTextBrowser)
        self.chat_history_edit = QTextBrowser(self)
        self.chat_history_edit.setOpenExternalLinks(False)
        self.chat_history_edit.anchorClicked.connect(self.on_chat_link_clicked)
        r_layout.addWidget(self.chat_history_edit)

        # Поле ввода сообщения и медиа-кнопки
        input_toolbar = QHBoxLayout()

        self.btn_attach = QPushButton("📎 Фото / Файл", self)
        self.btn_attach.clicked.connect(self.attach_and_send_file)
        input_toolbar.addWidget(self.btn_attach)

        self.btn_voice_note = QPushButton("🎤 Записать ГС", self)
        self.btn_voice_note.setStyleSheet("background-color: #374151; font-weight: bold;")
        self.btn_voice_note.clicked.connect(self.toggle_record_voice_note)
        input_toolbar.addWidget(self.btn_voice_note)

        self.voice_note_status = QLabel("", self)
        self.voice_note_status.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 11px;")
        input_toolbar.addWidget(self.voice_note_status)

        input_toolbar.addStretch()
        r_layout.addLayout(input_toolbar)

        msg_input_layout = QHBoxLayout()
        self.chat_input = QLineEdit(self)
        self.chat_input.setPlaceholderText("Напишите сообщение в канал...")
        self.chat_input.returnPressed.connect(self.send_chat_message)
        msg_input_layout.addWidget(self.chat_input)

        btn_send = QPushButton("Отправить", self)
        btn_send.setProperty("class", "primary-btn")
        btn_send.clicked.connect(self.send_chat_message)
        msg_input_layout.addWidget(btn_send)

        r_layout.addLayout(msg_input_layout)

        splitter.addWidget(right_panel)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 3)

        layout.addWidget(splitter)

    # ---------- ОБНОВЛЕНИЯ СОСТОЯНИЯ ----------
    def update_clock(self):
        now = QDateTime.currentDateTimeUtc()
        self.clock_label.setText(now.toString("hh:mm:ss") + " UTC")

    def update_call_timer(self):
        if self.call_start_time > 0:
            elapsed = int(time.time() - self.call_start_time)
            mins, secs = divmod(elapsed, 60)
            self.call_status_label.setText(f"Идёт вызов ({mins:02d}:{secs:02d})")

    def update_voice_note_timer(self):
        if self.is_recording_voice_note:
            elapsed = int(time.time() - self.voice_note_start_time)
            self.voice_note_status.setText(f"🔴 Идёт запись ГС: {elapsed} сек.")

    def on_connection_change(self, is_connected: bool):
        if is_connected:
            self.vps_indicator.setText("● VPS: Подключен")
            self.vps_indicator.setStyleSheet("color: #10B981; font-weight: bold; font-size: 12px;")
            self.statusBar().showMessage("Связь с VPS установлена.")
        else:
            self.vps_indicator.setText("● VPS: Офлайн")
            self.vps_indicator.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 12px;")
            self.statusBar().showMessage("Связь с VPS потеряна. Повторная попытка...")

    def on_state_received(self, state: Dict[str, Any]):
        self.map_view.update_state(state)

        # 1. Таблица бортов
        aircraft_list = state.get("aircraft", [])
        self.flights_table.setRowCount(len(aircraft_list))
        for row, ac in enumerate(aircraft_list):
            self.flights_table.setItem(row, 0, QTableWidgetItem(ac.get("flight", "-")))
            self.flights_table.setItem(row, 1, QTableWidgetItem(f"Стоянка {ac.get('stand', '-')}"))
            self.flights_table.setItem(row, 2, QTableWidgetItem(ac.get("model", "A320")))
            self.flights_table.setItem(row, 3, QTableWidgetItem(ac.get("status", "Обслуживание")))

            pbar = QProgressBar()
            pbar.setValue(min(100, int(ac.get("turnaround_progress", 40))))
            self.flights_table.setCellWidget(row, 4, pbar)

            btn_depart = QPushButton("Вылет")
            aid = ac.get("id")
            btn_depart.clicked.connect(lambda _, a=aid: self.depart_aircraft(a))
            self.flights_table.setCellWidget(row, 5, btn_depart)

        # 2. Таблица техников
        techs_list = state.get("techs", [])
        self.techs_table.setRowCount(len(techs_list))
        for row, t in enumerate(techs_list):
            self.techs_table.setItem(row, 0, QTableWidgetItem(t.get("name", "Техник")))
            self.techs_table.setItem(row, 1, QTableWidgetItem(t.get("qual", "Планер")))
            self.techs_table.setItem(row, 2, QTableWidgetItem(", ".join(t.get("types", []))))
            self.techs_table.setItem(row, 3, QTableWidgetItem(t.get("status", "Свободен")))
            self.techs_table.setItem(row, 4, QTableWidgetItem("Да" if t.get("on_shift", True) else "Нет"))

            btn_call_tech = QPushButton("Позвонить")
            tid = t.get("id")
            tname = t.get("name", "Техник")
            btn_call_tech.clicked.connect(lambda _, i=tid, n=tname: self.start_direct_call(i, n))
            self.techs_table.setCellWidget(row, 5, btn_call_tech)

        # 3. Таблица заявок с этапами выполнения
        requests_list = list(state.get("requests", {}).values())
        self.requests_table.setRowCount(len(requests_list))
        for row, r in enumerate(requests_list):
            rid = r.get("id")
            r_status = r.get("status", "waiting")
            self.requests_table.setItem(row, 0, QTableWidgetItem(f"#{rid}"))
            self.requests_table.setItem(row, 1, QTableWidgetItem(f"Стоянка {r.get('stand', '-')}"))
            self.requests_table.setItem(row, 2, QTableWidgetItem(r.get("description", "-")))
            self.requests_table.setItem(row, 3, QTableWidgetItem(r.get("priority", "normal")))
            self.requests_table.setItem(row, 4, QTableWidgetItem(r.get("tech_name", "Авто-подбор")))

            status_text = {
                "waiting": "Ожидает назначения",
                "pending": "Ожидает назначения",
                "enroute": "В пути к стоянке",
                "assigned": "В пути к стоянке",
                "arrived": "Инженер на месте",
                "working": "Выполняются работы",
                "done": "Дефект устранён",
                "cancelled": "Отменена"
            }.get(r_status, r_status)
            self.requests_table.setItem(row, 5, QTableWidgetItem(status_text))

            # Кнопка действия в зависимости от этапа
            action_btn = QPushButton("Действие")
            if r_status in ("waiting", "pending"):
                action_btn.setText("Отменить")
                action_btn.setProperty("class", "danger-btn")
                action_btn.clicked.connect(lambda _, req_id=rid: self.cancel_request_action(req_id))
            elif r_status in ("enroute", "assigned"):
                action_btn.setText("Прибыл на стоянку")
                action_btn.clicked.connect(lambda _, req_id=rid: self.arrive_request_action(req_id))
            elif r_status == "arrived":
                action_btn.setText("Начать работу")
                action_btn.clicked.connect(lambda _, req_id=rid: self.start_request_action(req_id))
            elif r_status == "working":
                action_btn.setText("Завершить (Устранено)")
                action_btn.setProperty("class", "success-btn")
                action_btn.clicked.connect(lambda _, req_id=rid: self.resolve_request_action(req_id))
            elif r_status == "done":
                action_btn.setText("Устранено ✓")
                action_btn.setEnabled(False)
            elif r_status == "cancelled":
                action_btn.setText("Отменена")
                action_btn.setEnabled(False)
            else:
                action_btn.setText("Выполнено")
                action_btn.setEnabled(False)

            self.requests_table.setCellWidget(row, 6, action_btn)

        # 4. Очередь допуска (Регистрация новых инженеров)
        registrations = state.get("registrations", [])
        self.pending_badge.setText(f"Ожидают проверки: {len(registrations)}")
        self.registrations_table.setRowCount(len(registrations))
        for row, reg in enumerate(registrations):
            uid = reg.get("id")
            self.registrations_table.setItem(row, 0, QTableWidgetItem(str(uid)))
            self.registrations_table.setItem(row, 1, QTableWidgetItem(reg.get("name", "-")))
            self.registrations_table.setItem(row, 2, QTableWidgetItem(reg.get("email", "-")))
            self.registrations_table.setItem(row, 3, QTableWidgetItem(reg.get("qual", "-")))
            self.registrations_table.setItem(row, 4, QTableWidgetItem(reg.get("base", "-")))
            self.registrations_table.setItem(row, 5, QTableWidgetItem(", ".join(reg.get("types", []))))

            btn_box = QWidget()
            b_layout = QHBoxLayout(btn_box)
            b_layout.setContentsMargins(2, 2, 2, 2)

            btn_approve = QPushButton("Допустить", btn_box)
            btn_approve.setProperty("class", "success-btn")
            btn_approve.clicked.connect(lambda _, u=uid: self.approve_engineer_action(u))
            b_layout.addWidget(btn_approve)

            btn_reject = QPushButton("Отклонить", btn_box)
            btn_reject.setProperty("class", "danger-btn")
            btn_reject.clicked.connect(lambda _, u=uid: self.reject_engineer_action(u))
            b_layout.addWidget(btn_reject)

            self.registrations_table.setCellWidget(row, 6, btn_box)

    # ---------- ДЕЙСТВИЯ С ЗАЯВКАМИ ----------
    def arrive_request_action(self, rid: int):
        try:
            self.client.arrive_request(rid)
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось отметить прибытие: {e}")

    def start_request_action(self, rid: int):
        try:
            self.client.start_request(rid)
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось начать работы: {e}")

    def resolve_request_action(self, rid: int):
        try:
            self.client.resolve_request(rid)
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось завершить заявку: {e}")

    def cancel_request_action(self, rid: int):
        try:
            self.client.cancel_request(rid)
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось отменить заявку: {e}")

    # ---------- РЕГИСТРАЦИЯ И ДОПУСК ----------
    def approve_engineer_action(self, user_id: int):
        try:
            res = self.client.approve_registration(user_id)
            QMessageBox.information(self, "Допуск подтверждён", f"Инженер {res.get('user', {}).get('name')} успешно допущен к смене!")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось допустить инженера: {e}")

    def reject_engineer_action(self, user_id: int):
        try:
            self.client.reject_registration(user_id)
            QMessageBox.information(self, "Отклонено", "Заявка на регистрацию отклонена.")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось отклонить заявку: {e}")

    def open_registration_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Регистрация нового инженера")
        dialog.setFixedWidth(440)
        d_layout = QFormLayout(dialog)

        name_in = QLineEdit(dialog)
        name_in.setPlaceholderText("Иванов Иван Иванович")
        username_in = QLineEdit(dialog)
        username_in.setPlaceholderText("ivanov_to (латинские буквы, цифры, _)")
        email_in = QLineEdit(dialog)
        email_in.setPlaceholderText("engineer@oto.ru")
        pass_in = QLineEdit(dialog)
        pass_in.setPlaceholderText("Минимум 8 символов")
        pass_in.setEchoMode(QLineEdit.EchoMode.Password)

        qual_combo = QComboBox(dialog)
        qual_combo.addItems(["Планер", "Двигатель", "Авионика"])

        base_combo = QComboBox(dialog)
        base_combo.addItems(["BASE1", "BASE2", "BASE3"])

        types_in = QLineEdit("A320, B737", dialog)

        d_layout.addRow("ФИО инженера:", name_in)
        d_layout.addRow("Позывной (@юзернейм):", username_in)
        d_layout.addRow("Email:", email_in)
        d_layout.addRow("Пароль:", pass_in)
        d_layout.addRow("Квалификация:", qual_combo)
        d_layout.addRow("База ТО:", base_combo)
        d_layout.addRow("Допуски ВС (через запятую):", types_in)

        btn_box = QHBoxLayout()
        btn_reg = QPushButton("Отправить заявку", dialog)
        btn_reg.setProperty("class", "primary-btn")
        btn_reg.clicked.connect(dialog.accept)
        btn_box.addWidget(btn_reg)
        d_layout.addRow(btn_box)

        if dialog.exec():
            name = name_in.text().strip()
            uname = username_in.text().strip().lstrip("@")
            email = email_in.text().strip()
            pwd = pass_in.text().strip()
            qual = qual_combo.currentText()
            base = base_combo.currentText()
            types = [t.strip() for t in types_in.text().split(",") if t.strip()]

            if name and email and pwd:
                try:
                    self.client.register_engineer(name, email, pwd, qual, types, base, uname or None)
                    QMessageBox.information(self, "Заявка отправлена", f"Заявка на регистрацию {name} (@{uname or 'auto'}) создана и ожидает допуска.")
                except Exception as e:
                    QMessageBox.warning(self, "Ошибка", f"Не удалось зарегистрировать: {e}")

    # ---------- ДИАЛОГИ И КАРТА ----------
    def on_airport_changed(self, index: int):
        try:
            airport_data = self.client.get_airport()
            self.airport_data = airport_data
            self.map_view.load_airport(airport_data)
        except Exception as e:
            self.statusBar().showMessage(f"Ошибка загрузки карты: {e}")

    def spawn_aircraft(self):
        try:
            self.client.session.post(f"{self.client.base_url}/api/aircraft/spawn")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось добавить борт: {e}")

    def depart_aircraft(self, aid: int):
        try:
            self.client.session.post(f"{self.client.base_url}/api/aircraft/{aid}/depart")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось отправить борт: {e}")

    def open_new_request_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Новая заявка на обслуживание")
        dialog.setFixedWidth(440)
        d_layout = QFormLayout(dialog)

        # Выпадающий список со стоянками и бортами аэропорта
        stand_combo = QComboBox(dialog)
        stand_combo.setEditable(True)
        available_stands = []
        if hasattr(self, "airport_data") and self.airport_data:
            stands = self.airport_data.get("stands", [])
            for s in stands:
                sid = s.get("id") if isinstance(s, dict) else str(s)
                if sid and sid not in available_stands:
                    available_stands.append(sid)
        if not available_stands:
            available_stands = [f"ВС-{i:02d}" for i in range(1, 25)]
        stand_combo.addItems(available_stands)

        desc_input = QLineEdit(dialog)
        desc_input.setPlaceholderText("Опишите дефект, например: отказ гидросистемы")
        qual_combo = QComboBox(dialog)
        qual_combo.addItems(["auto (Автоподбор)", "Планер", "Двигатель", "Авионика"])
        prio_combo = QComboBox(dialog)
        prio_combo.addItems(["normal (Обычный)", "emergency (ЧС / Норматив 15м)"])

        d_layout.addRow("Стоянка ВС:", stand_combo)
        d_layout.addRow("Описание дефекта:", desc_input)
        d_layout.addRow("Квалификация:", qual_combo)
        d_layout.addRow("Приоритет:", prio_combo)

        btn_box = QHBoxLayout()
        btn_ok = QPushButton("Создать заявку", dialog)
        btn_ok.setProperty("class", "primary-btn")
        btn_ok.clicked.connect(dialog.accept)
        btn_box.addWidget(btn_ok)
        d_layout.addRow(btn_box)

        if dialog.exec():
            stand = stand_combo.currentText().strip()
            desc = desc_input.text().strip()
            qual = qual_combo.currentText().split()[0]
            prio = prio_combo.currentText().split()[0]
            if stand and desc:
                try:
                    self.client.create_request(stand, desc, qual, prio)
                    self.statusBar().showMessage(f"Заявка на стоянку {stand} создана.")
                except Exception as e:
                    QMessageBox.warning(self, "Ошибка", f"Не удалось создать заявку: {e}")

    # ---------- ЧАТ, МЕДИА И ГОЛОСОВЫЕ СООБЩЕНИЯ (ГС) ----------
    def refresh_contacts(self):
        try:
            self.raw_contacts = self.client.get_contacts()
            current_q = self.contact_search.text() if hasattr(self, "contact_search") else ""
            self.filter_contacts_list(current_q)
        except Exception:
            pass

    def filter_contacts_list(self, query: str = ""):
        self.rooms_list.clear()
        q = (query or "").strip().lower().lstrip("@")
        folder = getattr(self, "contact_folder_filter", "all")

        # 1. Общий канал смены (отображается во 'Все' и 'Каналы')
        if folder in ("all", "channels"):
            if not q or any(x in q for x in ("смен", "общ", "канал", "shift", "all")):
                item_shift = QListWidgetItem("📢 Общий канал смены")
                item_shift.setData(Qt.ItemDataRole.UserRole, ("shift", None, "Общий канал смены"))
                item_shift.setToolTip("Оперативный эфир смены (видят все диспетчеры и инженеры)")
                self.rooms_list.addItem(item_shift)

        if folder == "channels":
            return

        # 2. Список сотрудников
        for c in getattr(self, "raw_contacts", []):
            cid = c.get("id")
            cname = c.get("name", "Сотрудник")
            uname = c.get("username", f"user{cid}")
            role = c.get("role", "engineer")
            qual = c.get("qual") or ("Диспетчер" if role == "dispatcher" else "ТО")
            on_shift = c.get("on_shift", True)
            bio = c.get("bio", "")

            # Фильтрация по папкам
            if folder == "engineers" and role != "engineer":
                continue
            if folder == "dispatchers" and role != "dispatcher":
                continue

            if q:
                match = (
                    q in uname.lower()
                    or q in cname.lower()
                    or q in qual.lower()
                    or q in bio.lower()
                    or (role == "dispatcher" and any(x in q for x in ("дисп", "disp")))
                    or (role == "engineer" and any(x in q for x in ("инж", "тех", "то", "eng")))
                )
                if not match:
                    continue

            status_dot = "🟢" if on_shift else "⚪"
            role_icon = "👮" if role == "dispatcher" else "🔧"
            title_str = f"{status_dot} {role_icon} {cname} (@{uname})"
            item = QListWidgetItem(title_str)
            item.setData(Qt.ItemDataRole.UserRole, ("direct", cid, f"{cname} (@{uname})"))
            bio_line = f"\nО себе: {bio}" if bio else ""
            item.setToolTip(f"{cname} (@{uname})\nРоль: {qual}{bio_line}\nСмена: {'На смене' if on_shift else 'Смена завершена'}")
            self.rooms_list.addItem(item)

    def on_room_clicked(self, item: QListWidgetItem):
        data = item.data(Qt.ItemDataRole.UserRole)
        if not data:
            return
        kind, peer_id, name = data
        self.active_room_kind = kind
        self.active_peer_id = peer_id
        self.active_peer_name = name
        self.chat_title_label.setText(name)
        self.chat_input.setPlaceholderText(f"Напишите в {name}...")
        self.load_chat_history()

    def load_chat_history(self):
        try:
            self.active_chat_messages = self.client.get_chat_history(self.active_room_kind, self.active_peer_id)
            current_filter = self.msg_search_input.text() if hasattr(self, "msg_search_input") else ""
            self.render_messages(current_filter)
        except Exception as e:
            self.chat_history_edit.setPlainText(f"Не удалось загрузить историю: {e}")

    def on_message_search_changed(self, text: str):
        self.render_messages(text.strip().lower())

    def render_messages(self, search_query: str = ""):
        self.chat_history_edit.clear()
        messages = getattr(self, "active_chat_messages", [])
        if search_query:
            messages = [
                m for m in messages
                if search_query in (m.get("body") or "").lower()
                or search_query in (m.get("sender_name") or "").lower()
                or search_query in (m.get("sender_username") or "").lower()
                or search_query in (m.get("media_name") or "").lower()
            ]

        for m in messages:
            self.append_message_html(m)

        # Автоматическая прокрутка к последнему сообщению
        cursor = self.chat_history_edit.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        self.chat_history_edit.setTextCursor(cursor)

    def append_message_html(self, m: Dict[str, Any]):
        sender = m.get("sender_name", "Сотрудник")
        sender_uname = m.get("sender_username") or m.get("username") or ""
        body = m.get("body", "")
        time_str = m.get("created_at", "")[:19].replace("T", " ")
        if len(time_str) >= 16:
            time_str = time_str[11:16]  # hh:mm

        media_url = m.get("media_url")
        media_type = m.get("media_type")
        media_name = m.get("media_name", "файл")
        duration = m.get("duration")

        is_me = self.current_user and m.get("sender_id") == self.current_user.get("id")

        full_url = f"{self.client.base_url}{media_url}" if media_url and not media_url.startswith("http") else media_url

        media_html = ""
        if media_type == "image" and full_url:
            media_html = f"""<div style='margin-top:6px;'>
                <a href='{full_url}'><img src='{full_url}' width='260' style='border-radius:8px; border:1px solid #334155;'></a><br>
                <small style='color:#94A3B8;'>🖼 {media_name}</small>
            </div>"""
        elif media_type == "audio_voice" and full_url:
            dur_str = f"{duration} сек." if duration else "Аудио"
            media_html = f"""<div style='margin-top:6px; background-color:#0F172A; border:1px solid #38BDF8; padding:6px 12px; border-radius:8px; display:inline-block;'>
                <b style='color:#38BDF8;'>🎙 Голосовое сообщение ({dur_str})</b> &nbsp; 
                <a href='play:{full_url}' style='background-color:#2563EB; color:white; padding:3px 10px; border-radius:4px; text-decoration:none; font-weight:bold;'>▶ Прослушать</a>
            </div>"""
        elif media_url:
            media_html = f"""<div style='margin-top:6px; background-color:#0F172A; border:1px solid #475569; padding:6px 12px; border-radius:8px; display:inline-block;'>
                <b style='color:#E2E8F0;'>📎 {media_name}</b> &nbsp; 
                <a href='{full_url}' style='color:#38BDF8; text-decoration:underline; font-weight:bold;'>[Скачать]</a>
            </div>"""

        body_html = f"<div style='font-size:13px; line-height:1.4; margin-top:2px;'>{body}</div>" if body else ""
        uname_tag = f"<span style='color:#94A3B8; font-size:11px; margin-left:4px;'>@{sender_uname}</span>" if sender_uname else ""

        if is_me:
            # Моё сообщение (справа, Telegram синий #2B5278)
            bubble = f"""
            <table width='100%' border='0' cellpadding='0' cellspacing='0' style='margin:4px 0;'>
              <tr>
                <td width='25%'></td>
                <td width='75%' align='right'>
                  <div style='background-color:#2B5278; border:1px solid #3E6E9B; border-radius:14px 14px 3px 14px; padding:8px 14px; text-align:left; display:inline-block; max-width:88%; box-shadow: 0 2px 5px rgba(0,0,0,0.25);'>
                    <div style='margin-bottom:3px;'>
                      <b style='color:#A6D4FF; font-size:11px;'>Вы</b>
                      {uname_tag}
                      <span style='color:#7EAEE2; font-size:10px; margin-left:8px;'>{time_str} ✓✓</span>
                    </div>
                    {body_html}
                    {media_html}
                  </div>
                </td>
              </tr>
            </table>
            """
        else:
            # Входящее сообщение (слева, Telegram карточка #182533)
            initials = "".join([part[:1].upper() for part in sender.split()[:2]]) or "СП"
            avatar_col = m.get("avatar_color") or "#2AABEE"
            bubble = f"""
            <table width='100%' border='0' cellpadding='0' cellspacing='0' style='margin:4px 0;'>
              <tr>
                <td width='75%' align='left'>
                  <div style='background-color:#182533; border:1px solid #233446; border-radius:14px 14px 14px 3px; padding:8px 14px; text-align:left; display:inline-block; max-width:88%; box-shadow: 0 2px 5px rgba(0,0,0,0.25);'>
                    <div style='margin-bottom:3px;'>
                      <span style='background:{avatar_col}; color:white; border-radius:10px; padding:2px 7px; font-weight:bold; font-size:10px;'>{initials}</span>
                      <b style='color:#64B5F6; font-size:11px; margin-left:6px;'>{sender}</b>
                      {uname_tag}
                      <span style='color:#708499; font-size:10px; margin-left:8px;'>{time_str}</span>
                    </div>
                    {body_html}
                    {media_html}
                  </div>
                </td>
                <td width='25%'></td>
              </tr>
            </table>
            """

        self.chat_history_edit.append(bubble)

    def on_chat_link_clicked(self, url: QUrl):
        url_str = url.toString()
        if url_str.startswith("play:"):
            # Воспроизведение голосового сообщения (ГС)
            audio_url = url_str[5:]
            self.statusBar().showMessage(f"Воспроизведение аудио: {audio_url}")
            try:
                resp = self.client.session.get(audio_url, timeout=15)
                if resp.ok:
                    self.voice_player.play_wav(resp.content)
            except Exception as e:
                QMessageBox.warning(self, "Ошибка воспроизведения", f"Не удалось воспроизвести аудио: {e}")
        else:
            QDesktopServices.openUrl(url)

    def send_chat_message(self):
        if not self.client.token:
            QMessageBox.warning(self, "Авторизация", "Вы не авторизованы. Сначала подключитесь к серверу и выполните вход.")
            self.open_login_dialog()
            return

        text = self.chat_input.text().strip()
        if not text:
            return
        try:
            self.client.send_chat_message(text, self.active_room_kind, self.active_peer_id)
            now_str = QDateTime.currentDateTime().toString("hh:mm:ss")
            my_name = self.current_user.get("name", "Пользователь") if self.current_user else "Пользователь"
            my_uname = self.current_user.get("username", "") if self.current_user else ""
            msg_dict = {
                "sender_name": my_name,
                "sender_username": my_uname,
                "sender_id": self.current_user.get("id") if self.current_user else 0,
                "body": text,
                "created_at": now_str,
            }
            if not hasattr(self, "active_chat_messages"):
                self.active_chat_messages = []
            self.active_chat_messages.append(msg_dict)
            self.append_message_html(msg_dict)
            self.chat_input.clear()
        except Exception as e:
            QMessageBox.warning(self, "Ошибка чата", f"Не удалось отправить сообщение:\n{e}")

    def attach_and_send_file(self):
        if not self.client.token:
            QMessageBox.warning(self, "Авторизация", "Вы не авторизованы. Сначала подключитесь к серверу и выполните вход.")
            self.open_login_dialog()
            return

        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Прикрепить медиа или документ",
            "",
            "Все файлы (*.*);;Изображения (*.png *.jpg *.jpeg *.webp);;Аудио (*.wav *.mp3 *.ogg);;Документы (*.pdf *.docx *.txt)",
        )
        if not file_path:
            return
        try:
            self.statusBar().showMessage("Загрузка файла на VPS...")
            upload_res = self.client.upload_media(file_path)
            media_url = upload_res.get("url")
            media_type = upload_res.get("media_type")
            media_name = upload_res.get("media_name")

            self.client.send_chat_message(
                body="",
                room_kind=self.active_room_kind,
                recipient_id=self.active_peer_id,
                media_url=media_url,
                media_type=media_type,
                media_name=media_name,
            )
            now_str = QDateTime.currentDateTime().toString("hh:mm:ss")
            my_name = self.current_user.get("name", "Пользователь") if self.current_user else "Пользователь"
            self.append_message_html({
                "sender_name": my_name,
                "sender_id": self.current_user.get("id") if self.current_user else 0,
                "body": "",
                "created_at": now_str,
                "media_url": media_url,
                "media_type": media_type,
                "media_name": media_name,
            })
            self.statusBar().showMessage("Файл успешно отправлен в чат.")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка загрузки", f"Не удалось отправить файл: {e}")

    def toggle_record_voice_note(self):
        if not self.client.token:
            QMessageBox.warning(self, "Авторизация", "Вы не авторизованы. Сначала подключитесь к серверу и выполните вход.")
            self.open_login_dialog()
            return
        if not self.is_recording_voice_note:
            # Старт записи ГС
            self.is_recording_voice_note = True
            self.voice_note_start_time = time.time()
            self.voice_recorder.start_recording(self.temp_voice_file)
            self.btn_voice_note.setText("⏹ Отправить ГС")
            self.btn_voice_note.setStyleSheet("background-color: #DC2626; color: white; font-weight: bold;")
            self.voice_note_timer.start(500)
            self.statusBar().showMessage("Запись голосового сообщения...")
        else:
            # Остановка записи и отправка
            self.is_recording_voice_note = False
            self.voice_note_timer.stop()
            self.voice_note_status.setText("")
            self.btn_voice_note.setText("🎤 Записать ГС")
            self.btn_voice_note.setStyleSheet("background-color: #374151; font-weight: bold;")

            out_path, duration = self.voice_recorder.stop_recording()
            if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
                try:
                    self.statusBar().showMessage("Отправка ГС на сервер...")
                    upload_res = self.client.upload_media(out_path)
                    media_url = upload_res.get("url")

                    self.client.send_chat_message(
                        body="",
                        room_kind=self.active_room_kind,
                        recipient_id=self.active_peer_id,
                        media_url=media_url,
                        media_type="audio_voice",
                        media_name=f"Голосовое сообщение ({duration}с)",
                        duration=duration,
                    )
                    now_str = QDateTime.currentDateTime().toString("hh:mm:ss")
                    my_name = self.current_user.get("name", "Диспетчер") if self.current_user else "Диспетчер"
                    self.append_message_html({
                        "sender_name": my_name,
                        "sender_id": self.current_user.get("id") if self.current_user else 0,
                        "body": "",
                        "created_at": now_str,
                        "media_url": media_url,
                        "media_type": "audio_voice",
                        "media_name": f"Голосовое сообщение ({duration}с)",
                        "duration": duration,
                    })
                    self.statusBar().showMessage("Голосовое сообщение отправлено.")
                except Exception as e:
                    QMessageBox.warning(self, "Ошибка отправки ГС", f"Не удалось отправить голосовое сообщение: {e}")

    def on_chat_message_received(self, msg: Dict[str, Any]):
        if self.settings.value("sound_alert", True, type=bool):
            QApplication.beep()
        if not hasattr(self, "active_chat_messages"):
            self.active_chat_messages = []
        self.active_chat_messages.append(msg)
        self.append_message_html(msg)

    # ---------- ГОЛОСОВЫЕ ВЫЗОВЫ (Walkie-Talkie / Звонки) ----------
    def start_direct_call(self, peer_id: int, peer_name: str):
        self.tabs.setCurrentWidget(self.tab_chat)
        self.active_room_kind = "direct"
        self.active_peer_id = peer_id
        self.active_peer_name = peer_name
        self.chat_title_label.setText(peer_name)
        self.toggle_voice_call()

    def toggle_voice_call(self):
        if self.voice.is_in_call:
            self.voice.end_call()
            if self.active_peer_id:
                self.client.send_call_signal({"kind": "hangup"}, self.active_peer_id)
            self.call_btn.setText("📞 Голосовой вызов")
            self.call_btn.setProperty("class", "success-btn")
            self.call_status_label.setText("Связь свободна")
            self.mute_btn.setEnabled(False)
            self.call_timer.stop()
        else:
            if not self.active_peer_id:
                QMessageBox.information(self, "Голосовая связь", "Выберите сотрудника из списка для голосового вызова.")
                return
            call_id = f"call_{min(self.client.user.get('id', 1), self.active_peer_id)}_{max(self.client.user.get('id', 1), self.active_peer_id)}"
            self.active_call_id = call_id
            self.voice.set_base_url(self.client.base_url)
            self.voice.start_call(call_id, self.client.token or "")

            self.client.send_call_signal({"kind": "ring", "call_id": call_id}, self.active_peer_id)

            self.call_btn.setText("📴 Завершить звонок")
            self.call_btn.setProperty("class", "danger-btn")
            self.call_status_label.setText("Соединение с VPS...")
            self.mute_btn.setEnabled(True)
            self.call_start_time = time.time()
            self.call_timer.start(1000)

    def toggle_mute(self):
        is_muted = self.voice.toggle_mute()
        if is_muted:
            self.mute_btn.setText("🔇 Микрофон ВЫКЛ")
            self.mute_btn.setProperty("class", "danger-btn")
        else:
            self.mute_btn.setText("🎤 Микрофон вкл")
            self.mute_btn.setProperty("class", "")

    def on_voice_call_connected(self, call_id: str):
        self.call_status_label.setText("● В эфире (Связь активна)")
        self.call_status_label.setStyleSheet("color: #10B981; font-weight: bold;")

    def on_voice_call_ended(self):
        self.call_btn.setText("📞 Голосовой вызов")
        self.call_btn.setProperty("class", "success-btn")
        self.call_status_label.setText("Связь свободна")
        self.call_status_label.setStyleSheet("color: #94A3B8;")
        self.mute_btn.setEnabled(False)
        self.call_timer.stop()
        self.call_start_time = 0.0

    def on_call_signal(self, sig: Dict[str, Any]):
        kind = sig.get("kind")
        from_name = sig.get("from_name", "Сотрудник")
        from_id = sig.get("from_user_id")
        call_id = sig.get("call_id")

        if kind == "ring":
            ret = QMessageBox.question(self, "Входящий вызов", f"Входящий голосовой вызов от {from_name}.\nПринять вызов?", QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if ret == QMessageBox.StandardButton.Yes and from_id and call_id:
                self.active_peer_id = from_id
                self.active_peer_name = from_name
                self.voice.set_base_url(self.client.base_url)
                self.voice.start_call(call_id, self.client.token or "")
                self.call_btn.setText("📴 Завершить звонок")
                self.call_btn.setProperty("class", "danger-btn")
                self.mute_btn.setEnabled(True)
                self.call_start_time = time.time()
                self.call_timer.start(1000)
            elif from_id:
                self.client.send_call_signal({"kind": "decline"}, from_id)
        elif kind in ("hangup", "decline"):
            self.voice.end_call()
            self.on_voice_call_ended()

    # ---------- ДИАЛОГ АВТОРИЗАЦИИ И НАСТРОЕК ----------
    def open_login_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Авторизация · RampPulse Operations")
        dialog.setFixedWidth(460)
        dialog.setStyleSheet("background-color: #0F172A; color: #F8FAFC;")
        d_layout = QVBoxLayout(dialog)
        d_layout.setContentsMargins(20, 20, 20, 20)
        d_layout.setSpacing(14)

        title = QLabel("Вход в систему управления аэропортом", dialog)
        title.setStyleSheet("font-size: 16px; font-weight: bold; color: #38BDF8;")
        d_layout.addWidget(title)

        sub = QLabel("Выберите демо-профиль в 1 клик или введите свои данные:", dialog)
        sub.setStyleSheet("font-size: 11px; color: #94A3B8;")
        d_layout.addWidget(sub)

        demo_box = QHBoxLayout()
        btn_disp = QPushButton("👮 Войти как Диспетчер", dialog)
        btn_disp.setStyleSheet("background-color: #1E293B; border: 1px solid #38BDF8; color: #38BDF8; font-weight: bold; padding: 8px;")
        btn_eng = QPushButton("🔧 Войти как Инженер (ТО)", dialog)
        btn_eng.setStyleSheet("background-color: #1E293B; border: 1px solid #10B981; color: #10B981; font-weight: bold; padding: 8px;")
        demo_box.addWidget(btn_disp)
        demo_box.addWidget(btn_eng)
        d_layout.addLayout(demo_box)

        form = QFormLayout()
        server_input = QLineEdit(self.settings.value("server_url", self.client.base_url), dialog)
        email_input = QLineEdit(self.settings.value("email", "dispatcher@oto.ru"), dialog)
        pass_input = QLineEdit(self.settings.value("password", "Dispatcher2026!"), dialog)
        pass_input.setEchoMode(QLineEdit.EchoMode.Password)

        def pick_disp():
            email_input.setText("dispatcher@oto.ru")
            pass_input.setText("Dispatcher2026!")

        def pick_eng():
            email_input.setText("tech1@oto.ru")
            pass_input.setText("Engineer2026!")

        btn_disp.clicked.connect(pick_disp)
        btn_eng.clicked.connect(pick_eng)

        form.addRow("Сервер VPS:", server_input)
        form.addRow("Email:", email_input)
        form.addRow("Пароль:", pass_input)
        d_layout.addLayout(form)

        err_label = QLabel("", dialog)
        err_label.setStyleSheet("color: #EF4444; font-size: 11px;")
        d_layout.addWidget(err_label)

        btn_login = QPushButton("Войти в систему", dialog)
        btn_login.setProperty("class", "primary-btn")
        btn_login.setStyleSheet("background-color: #2563EB; color: white; font-size: 14px; font-weight: bold; padding: 10px; border-radius: 6px;")

        def do_login():
            srv = server_input.text().strip()
            em = email_input.text().strip()
            pw = pass_input.text().strip()
            if not srv or not em or not pw:
                err_label.setText("Заполните все поля.")
                return
            err_label.setText("Подключение к серверу...")
            QApplication.processEvents()
            try:
                self.connect_to_server(srv, em, pw)
                self.settings.setValue("server_url", srv)
                self.settings.setValue("email", em)
                self.settings.setValue("password", pw)
                self.settings.setValue("auto_login", True)
                dialog.accept()
            except Exception as e:
                err_label.setText(f"Ошибка входа: {e}")

        btn_login.clicked.connect(do_login)
        d_layout.addWidget(btn_login)

        btn_reg = QPushButton("Подать заявку на регистрацию нового инженера", dialog)
        btn_reg.setStyleSheet("color: #94A3B8; text-decoration: underline; background: none; border: none; padding: 4px;")
        btn_reg.clicked.connect(lambda: (dialog.reject(), self.open_register_engineer_dialog()))
        d_layout.addWidget(btn_reg)

        dialog.exec()

    def refresh_user_badge(self):
        if not self.current_user:
            self.user_label.setText("Не авторизован")
            self.user_label.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 12px;")
            return
        u = self.current_user
        name = u.get("name", "Пользователь")
        uname = u.get("username", "")
        role = u.get("role", "dispatcher")
        qual = u.get("qual", "ТО")
        role_ru = "Диспетчер" if role == "dispatcher" else f"Инженер ({qual})"
        uname_badge = f" (@{uname})" if uname else ""
        self.user_label.setText(f"👤 {name}{uname_badge} · {role_ru} (🟢 В сети)")
        self.user_label.setStyleSheet("color: #10B981; font-weight: bold; font-size: 12px;")
        if hasattr(self, "chat_current_user_label"):
            self.chat_current_user_label.setText(f"Вы: {name}{uname_badge} ({role_ru})")

    def connect_to_server(self, url: str, email: str, password: str):
        self.client.set_base_url(url)
        self.voice.set_base_url(url)
        try:
            login_data = self.client.login(email, password)
            self.current_user = login_data.get("user")
            self.refresh_user_badge()

            airport_data = self.client.get_airport()
            self.airport_data = airport_data
            self.map_view.load_airport(airport_data)

            self.client.start_websocket()
            self.refresh_contacts()
            self.load_chat_history()
            self.update_profile_tab_ui()

            u_name = self.current_user.get("name", "Пользователь")
            self.statusBar().showMessage(f"Успешное подключение к {url} под именем {u_name}")
        except Exception as e:
            self.user_label.setText("Ошибка авторизации")
            self.user_label.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 12px;")
            raise e

    # ---------- ВКЛАДКА: ПРОФИЛЬ И НАСТРОЙКИ (TELEGRAM STYLE) ----------
    def init_settings_tab(self):
        layout = QVBoxLayout(self.tab_settings)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(16)

        # 1. Профиль Telegram
        profile_group = QGroupBox("👤 Профиль сотрудника (Telegram Style)", self.tab_settings)
        p_vbox = QVBoxLayout(profile_group)
        p_vbox.setContentsMargins(18, 18, 18, 18)
        p_vbox.setSpacing(14)

        # Карточка профиля с большим аватаром
        header_layout = QHBoxLayout()
        header_layout.setSpacing(16)

        self.tg_avatar_preview = QLabel("ТО", profile_group)
        self.tg_avatar_preview.setFixedSize(76, 76)
        self.tg_avatar_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.current_avatar_color = "#2AABEE"
        self.tg_avatar_preview.setStyleSheet(
            f"background-color: {self.current_avatar_color}; color: white; font-size: 26px; font-weight: bold; border-radius: 38px; border: 2px solid #5288c1;"
        )
        header_layout.addWidget(self.tg_avatar_preview)

        meta_vbox = QVBoxLayout()
        meta_vbox.setSpacing(4)
        self.tg_user_title = QLabel("Пользователь", profile_group)
        self.tg_user_title.setStyleSheet("font-size: 18px; font-weight: bold; color: #F8FAFC;")
        self.tg_user_subtitle = QLabel("@username · 🟢 в сети", profile_group)
        self.tg_user_subtitle.setStyleSheet("font-size: 13px; color: #38BDF8; font-weight: 500;")
        self.tg_user_bio_preview = QLabel("О себе: —", profile_group)
        self.tg_user_bio_preview.setStyleSheet("font-size: 12px; color: #94A3B8; font-style: italic;")
        meta_vbox.addWidget(self.tg_user_title)
        meta_vbox.addWidget(self.tg_user_subtitle)
        meta_vbox.addWidget(self.tg_user_bio_preview)
        header_layout.addLayout(meta_vbox)
        header_layout.addStretch()
        p_vbox.addLayout(header_layout)

        # Выбор цвета аватара
        color_row = QHBoxLayout()
        color_label = QLabel("Цвет аватара:", profile_group)
        color_label.setStyleSheet("color: #94A3B8; font-size: 12px; font-weight: bold;")
        color_row.addWidget(color_label)

        palette = [
            ("#2AABEE", "Голубой"),
            ("#8E85EE", "Фиолетовый"),
            ("#45B9A5", "Бирюзовый"),
            ("#E57373", "Красный"),
            ("#F39C12", "Оранжевый"),
        ]
        self.color_buttons = []
        for col, col_name in palette:
            btn_c = QPushButton(profile_group)
            btn_c.setFixedSize(28, 28)
            btn_c.setToolTip(col_name)
            btn_c.setStyleSheet(f"background-color: {col}; border-radius: 14px; border: 2px solid #1E293B;")
            btn_c.clicked.connect(lambda _, c=col: self.set_avatar_color_choice(c))
            color_row.addWidget(btn_c)
            self.color_buttons.append((col, btn_c))
        color_row.addStretch()
        p_vbox.addLayout(color_row)

        # Форма редактирования данных
        form_grid = QFormLayout()
        form_grid.setSpacing(10)

        # ФИО
        self.prof_name_edit = QLineEdit(profile_group)
        self.prof_name_edit.setPlaceholderText("Фамилия Имя Отчество")
        self.prof_name_edit.setStyleSheet("background-color: #1E293B; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; color: #F8FAFC;")
        form_grid.addRow("ФИО сотрудника:", self.prof_name_edit)

        # @username
        uname_box = QHBoxLayout()
        uname_prefix = QLabel("@", profile_group)
        uname_prefix.setStyleSheet("font-weight: bold; font-size: 14px; color: #38BDF8;")
        self.prof_uname_edit = QLineEdit(profile_group)
        self.prof_uname_edit.setPlaceholderText("позывной_латиницей")
        self.prof_uname_edit.setStyleSheet("background-color: #1E293B; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; color: #F8FAFC;")
        uname_box.addWidget(uname_prefix)
        uname_box.addWidget(self.prof_uname_edit)
        form_grid.addRow("Позывной (@юзернейм):", uname_box)

        # Bio / О себе
        self.prof_bio_edit = QLineEdit(profile_group)
        self.prof_bio_edit.setPlaceholderText("Например: Диспетчер смены перрона Шереметьево · Смена №2")
        self.prof_bio_edit.setStyleSheet("background-color: #1E293B; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; color: #F8FAFC;")
        form_grid.addRow("О себе (Bio / Статус):", self.prof_bio_edit)

        p_vbox.addLayout(form_grid)

        # Кнопка сохранения профиля
        self.btn_save_full_profile = QPushButton("💾 Сохранить изменения профиля", profile_group)
        self.btn_save_full_profile.setStyleSheet("background-color: #2AABEE; color: white; font-weight: bold; font-size: 13px; padding: 10px; border-radius: 6px;")
        self.btn_save_full_profile.clicked.connect(self.save_full_profile_action)
        p_vbox.addWidget(self.btn_save_full_profile)

        # Системные данные
        info_group = QGroupBox("📋 Данные сотрудника и смена", profile_group)
        i_layout = QFormLayout(info_group)
        self.prof_email_label = QLabel("—", info_group)
        self.prof_role_label = QLabel("—", info_group)
        self.prof_qual_label = QLabel("—", info_group)
        self.prof_tech_id_label = QLabel("—", info_group)
        self.prof_shift_status_label = QLabel("—", info_group)
        for lbl in (self.prof_email_label, self.prof_role_label, self.prof_qual_label, self.prof_tech_id_label, self.prof_shift_status_label):
            lbl.setStyleSheet("font-weight: bold; font-size: 13px; color: #F8FAFC;")
        i_layout.addRow("Email:", self.prof_email_label)
        i_layout.addRow("Роль в системе:", self.prof_role_label)
        i_layout.addRow("Квалификация / Допуски:", self.prof_qual_label)
        i_layout.addRow("Табельный номер (Tech ID):", self.prof_tech_id_label)
        i_layout.addRow("Статус на смене:", self.prof_shift_status_label)

        self.btn_toggle_my_shift = QPushButton("Выйти на смену / Завершить смену", info_group)
        self.btn_toggle_my_shift.setStyleSheet("background-color: #1E293B; border: 1px solid #10B981; color: #10B981; font-weight: bold; padding: 6px 12px;")
        self.btn_toggle_my_shift.clicked.connect(self.toggle_my_shift_action)
        i_layout.addRow("Управление сменой:", self.btn_toggle_my_shift)
        p_vbox.addWidget(info_group)

        layout.addWidget(profile_group)

        # 2. Звук и Уведомления
        sound_group = QGroupBox("🔔 Звуковые оповещения и Аудио", self.tab_settings)
        s_layout = QFormLayout(sound_group)
        s_layout.setContentsMargins(16, 16, 16, 16)
        s_layout.setSpacing(10)

        self.sound_alert_cb = QCheckBox("Звуковой сигнал при входящем сообщении в чате", sound_group)
        self.sound_alert_cb.setChecked(self.settings.value("sound_alert", True, type=bool))
        self.sound_alert_cb.toggled.connect(lambda v: self.settings.setValue("sound_alert", v))

        test_sound_btn = QPushButton("🔊 Проверить звук уведомления", sound_group)
        test_sound_btn.clicked.connect(lambda: QApplication.beep())

        s_layout.addRow("Уведомления:", self.sound_alert_cb)
        s_layout.addRow("Тест аудио:", test_sound_btn)
        layout.addWidget(sound_group)

        # 3. Сеть и VPS сервер
        net_group = QGroupBox("🌐 Параметры сервера RampPulse VPS", self.tab_settings)
        n_layout = QFormLayout(net_group)
        n_layout.setContentsMargins(16, 16, 16, 16)
        n_layout.setSpacing(10)

        self.net_url_label = QLabel("—", net_group)
        self.net_url_label.setStyleSheet("font-family: monospace; font-size: 13px; color: #38BDF8;")
        self.net_status_label = QLabel("● Не подключен", net_group)
        self.net_status_label.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 13px;")

        n_layout.addRow("Адрес сервера VPS:", self.net_url_label)
        n_layout.addRow("Связь в реальном времени:", self.net_status_label)

        net_actions = QHBoxLayout()
        btn_ping = QPushButton("⚡ Проверить связь (Ping / RTT)", net_group)
        btn_ping.clicked.connect(self.ping_server_action)
        btn_reconnect = QPushButton("🔄 Сменить сервер / Войти", net_group)
        btn_reconnect.clicked.connect(self.open_login_dialog)
        net_actions.addWidget(btn_ping)
        net_actions.addWidget(btn_reconnect)
        n_layout.addRow("Действия:", net_actions)

        layout.addWidget(net_group)

        # 4. Выход
        btn_logout = QPushButton("🚪 Выйти из учётной записи (Сменить пользователя)", self.tab_settings)
        btn_logout.setStyleSheet("background-color: #DC2626; color: white; font-weight: bold; padding: 10px; border-radius: 6px;")
        btn_logout.clicked.connect(self.logout_action)
        layout.addWidget(btn_logout)

        layout.addStretch()

    def set_avatar_color_choice(self, col: str):
        self.current_avatar_color = col
        self.tg_avatar_preview.setStyleSheet(
            f"background-color: {col}; color: white; font-size: 26px; font-weight: bold; border-radius: 38px; border: 2px solid white;"
        )
        for c, btn in getattr(self, "color_buttons", []):
            if c == col:
                btn.setStyleSheet(f"background-color: {c}; border-radius: 14px; border: 2px solid white;")
            else:
                btn.setStyleSheet(f"background-color: {c}; border-radius: 14px; border: 2px solid #1E293B;")

    def update_profile_tab_ui(self):
        u = self.current_user or {}
        name = u.get("name", "Пользователь")
        uname = u.get("username", "")
        bio = u.get("bio", "")
        col = u.get("avatar_color") or "#2AABEE"
        self.current_avatar_color = col

        initials = "".join([p[:1].upper() for p in name.split()[:2]]) or "ТО"
        if hasattr(self, "tg_avatar_preview"):
            self.tg_avatar_preview.setText(initials)
            self.tg_avatar_preview.setStyleSheet(f"background-color: {col}; color: white; font-size: 26px; font-weight: bold; border-radius: 38px; border: 2px solid #5288c1;")
        if hasattr(self, "tg_user_title"):
            self.tg_user_title.setText(name)
        if hasattr(self, "tg_user_subtitle"):
            self.tg_user_subtitle.setText(f"@{uname} · 🟢 в сети" if uname else "🟢 в сети")
        if hasattr(self, "tg_user_bio_preview"):
            self.tg_user_bio_preview.setText(f"О себе: {bio}" if bio else "О себе: —")

        self.prof_name_edit.setText(name)
        self.prof_uname_edit.setText(uname)
        if hasattr(self, "prof_bio_edit"):
            self.prof_bio_edit.setText(bio)

        self.prof_email_label.setText(u.get("email", "—"))
        role_ru = "Диспетчер смены" if u.get("role") == "dispatcher" else "Инженер ТО"
        self.prof_role_label.setText(role_ru)
        self.prof_qual_label.setText(u.get("qual") or "Все допуски (Диспетчер)")
        self.prof_tech_id_label.setText(str(u.get("tech_id") or "DISP-01"))
        on_shift = u.get("on_shift", True)
        self.prof_shift_status_label.setText("🟢 На смене (Активен)" if on_shift else "⚪ Смена завершена")
        self.net_url_label.setText(self.client.base_url)
        self.net_status_label.setText("● Подключен к VPS" if self.client.is_connected else "● Офлайн")
        self.net_status_label.setStyleSheet("color: #10B981; font-weight: bold;" if self.client.is_connected else "color: #EF4444; font-weight: bold;")

    def save_full_profile_action(self):
        new_name = self.prof_name_edit.text().strip()
        new_uname = self.prof_uname_edit.text().strip().lstrip("@")
        new_bio = self.prof_bio_edit.text().strip() if hasattr(self, "prof_bio_edit") else ""
        col = getattr(self, "current_avatar_color", "#2AABEE")
        if not new_name:
            QMessageBox.warning(self, "Ошибка", "Укажите ФИО сотрудника.")
            return
        if not new_uname:
            QMessageBox.warning(self, "Ошибка", "Укажите позывной (@юзернейм).")
            return
        try:
            res = self.client.update_profile(username=new_uname, name=new_name, bio=new_bio, avatar_color=col)
            if "user" in res:
                self.current_user = res["user"]
            self.update_profile_tab_ui()
            self.refresh_user_badge()
            self.refresh_contacts()
            QMessageBox.information(self, "Профиль обновлён", f"✅ Профиль успешно сохранён!\nФИО: {new_name}\nПозывной: @{new_uname}\nО себе: {new_bio or '—'}")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка обновления", f"Не удалось обновить профиль:\n{e}")

    def save_username_action(self):
        self.save_full_profile_action()

    def save_name_action(self):
        self.save_full_profile_action()

    def ping_server_action(self):
        start = time.time()
        try:
            resp = self.client.session.get(f"{self.client.base_url}/healthz", timeout=5)
            rtt_ms = int((time.time() - start) * 1000)
            if resp.ok:
                data = resp.json()
                ap = data.get("airport", "SVO")
                QMessageBox.information(self, "Проверка связи", f"✅ Связь с VPS в норме!\nСервер: {self.client.base_url}\nАэропорт: {ap}\nЗадержка (RTT): {rtt_ms} мс")
            else:
                QMessageBox.warning(self, "Ошибка связи", f"Ответ сервера: HTTP {resp.status_code}")
        except Exception as e:
            QMessageBox.critical(self, "Ошибка связи", f"Не удалось подключиться к серверу:\n{e}")

    def toggle_my_shift_action(self):
        if not self.current_user:
            return
        current = self.current_user.get("on_shift", True)
        target = not current
        try:
            self.client.set_shift(target)
            self.current_user["on_shift"] = target
            self.update_profile_tab_ui()
            self.refresh_user_badge()
            status_txt = "вышли на смену" if target else "завершили смену"
            QMessageBox.information(self, "Смена", f"Вы успешно {status_txt}.")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка смены", f"Не удалось изменить статус смены:\n{e}")

    def logout_action(self):
        self.client.token = None
        self.client.user = None
        self.current_user = None
        self.settings.setValue("auto_login", False)
        self.refresh_user_badge()
        self.update_profile_tab_ui()
        self.open_login_dialog()
