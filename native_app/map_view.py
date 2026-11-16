"""
Нативный векторный интерактивный вид карты аэропорта на Qt6 (QGraphicsView).
Высокопроизводительный рендеринг без браузерного движка с поддержкой сглаживания (Anti-aliasing).
"""
import math
from typing import Any, Dict, List, Optional
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
    QWheelEvent,
)
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsScene,
    QGraphicsView,
    QToolTip,
    QWidget,
)


class AirportMapView(QGraphicsView):
    stand_selected = Signal(str)  # имя выбранной стоянки

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.scene = QGraphicsScene(self)
        self.setScene(self.scene)

        # Настройки отображения
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#070B12")))
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)

        self.airport_data: Dict[str, Any] = {}
        self.sim_state: Dict[str, Any] = {}
        self.scale_factor = 1.0

    def load_airport(self, data: Dict[str, Any]):
        self.airport_data = data
        self.redraw_scene()
        self.fit_airport()

    def update_state(self, state: Dict[str, Any]):
        self.sim_state = state
        self.redraw_scene()

    def wheelEvent(self, event: QWheelEvent):
        zoom_in = 1.15
        zoom_out = 1.0 / zoom_in
        if event.angleDelta().y() > 0:
            self.scale(zoom_in, zoom_in)
            self.scale_factor *= zoom_in
        else:
            self.scale(zoom_out, zoom_out)
            self.scale_factor *= zoom_out

    def fit_airport(self):
        rect = self.scene.itemsBoundingRect()
        if not rect.isEmpty():
            self.fitInView(rect.adjusted(-50, -50, 50, 50), Qt.AspectRatioMode.KeepAspectRatio)

    def redraw_scene(self):
        self.scene.clear()
        if not self.airport_data:
            return

        # 1. Отрисовка зон (перрон, ангары, терминалы)
        for area in self.airport_data.get("areas", []):
            points = area.get("points", [])
            if len(points) < 3:
                continue
            polygon = QPolygonF([QPointF(p[0], p[1]) for p in points])
            kind = area.get("kind", "")
            if kind == "terminal":
                brush = QBrush(QColor("#1E293B"))
                pen = QPen(QColor("#334155"), 2)
            elif kind == "hangar":
                brush = QBrush(QColor("#0F172A"))
                pen = QPen(QColor("#1E293B"), 2)
            else:  # apron (перрон)
                brush = QBrush(QColor("#0B1322"))
                pen = QPen(QColor("#1E293B"), 1, Qt.PenStyle.DashLine)

            poly_item = self.scene.addPolygon(polygon, pen, brush)
            poly_item.setZValue(1)

        # 2. Отрисовка взлётно-посадочных полос (ВПП)
        for rw in self.airport_data.get("runways", []):
            pts = rw.get("points", [])
            width = rw.get("width", 50)
            if len(pts) >= 2:
                p1, p2 = QPointF(pts[0][0], pts[0][1]), QPointF(pts[1][0], pts[1][1])
                # Полоса асфальта
                rw_pen = QPen(QColor("#1A202C"), width, Qt.PenStyle.SolidLine, Qt.PenCapStyle.FlatCap)
                line_item = self.scene.addLine(p1.x(), p1.y(), p2.x(), p2.y(), rw_pen)
                line_item.setZValue(2)
                # Осевая белая разметка полосы
                dash_pen = QPen(QColor("#E2E8F0"), 3, Qt.PenStyle.DashLine)
                dash_line = self.scene.addLine(p1.x(), p1.y(), p2.x(), p2.y(), dash_pen)
                dash_line.setZValue(3)

                # Текст номера полосы
                name = rw.get("name", "")
                if name:
                    text_item = self.scene.addText(f"ВПП {name}", QFont("Segoe UI", 12, QFont.Weight.Bold))
                    text_item.setDefaultTextColor(QColor("#94A3B8"))
                    text_item.setPos((p1.x() + p2.x()) / 2 - 40, (p1.y() + p2.y()) / 2 - 12)
                    text_item.setZValue(4)

        # 3. Дорожки и граф руления (Taxiways)
        nodes_dict = {n["id"]: (n["x"], n["y"]) for n in self.airport_data.get("nodes", [])}
        for edge in self.airport_data.get("edges", []):
            u, v = edge.get("u"), edge.get("v")
            if u in nodes_dict and v in nodes_dict:
                p1 = nodes_dict[u]
                p2 = nodes_dict[v]
                edge_pen = QPen(QColor("#1E3A5F"), 2, Qt.PenStyle.SolidLine)
                edge_line = self.scene.addLine(p1[0], p1[1], p2[0], p2[1], edge_pen)
                edge_line.setZValue(5)

        # 4. Стоянки самолётов (Stands)
        stands_dict = {s["id"]: s for s in self.airport_data.get("stands", [])}
        aircraft_by_stand = {}
        for ac in self.sim_state.get("aircraft", []):
            stand_id = ac.get("stand")
            if stand_id:
                aircraft_by_stand[stand_id] = ac

        for stand_id, s in stands_dict.items():
            x, y = s.get("x", 0), s.get("y", 0)
            has_ac = stand_id in aircraft_by_stand
            radius = 24 if has_ac else 18

            circle_brush = QBrush(QColor("#0369A1" if has_ac else "#0F172A"))
            circle_pen = QPen(QColor("#38BDF8" if has_ac else "#334155"), 2)
            stand_circle = self.scene.addEllipse(x - radius, y - radius, radius * 2, radius * 2, circle_pen, circle_brush)
            stand_circle.setZValue(6)

            # Номер стоянки
            font = QFont("Segoe UI", 9, QFont.Weight.Bold)
            text_item = self.scene.addText(str(s.get("name", stand_id)), font)
            text_item.setDefaultTextColor(QColor("#FFFFFF" if has_ac else "#94A3B8"))
            text_item.setPos(x - 12, y - 10)
            text_item.setZValue(7)

            # Если на стоянке самолёт
            if has_ac:
                ac = aircraft_by_stand[stand_id]
                flight_no = ac.get("flight", "FLIGHT")
                model = ac.get("model", "A320")
                status = ac.get("status", "Обслуживание")

                ac_text = self.scene.addText(f"✈ {flight_no}\n{model}", QFont("Segoe UI", 8, QFont.Weight.Bold))
                ac_text.setDefaultTextColor(QColor("#F8FAFC"))
                ac_text.setPos(x - 30, y + radius + 2)
                ac_text.setZValue(8)

        # 5. Инженеры и техники на карте
        for tech in self.sim_state.get("techs", []):
            tx, ty = tech.get("x", 0), tech.get("y", 0)
            if tx == 0 and ty == 0:
                continue

            qual = tech.get("qual", "Планер")
            tech_color = QColor("#10B981") if qual == "Планер" else QColor("#38BDF8") if qual == "Двигатель" else QColor("#A855F7")

            # Внешний ореол и маркер инженера
            halo = self.scene.addEllipse(tx - 12, ty - 12, 24, 24, QPen(Qt.PenStyle.NoPen), QBrush(QColor(tech_color.red(), tech_color.green(), tech_color.blue(), 60)))
            halo.setZValue(9)

            dot = self.scene.addEllipse(tx - 6, ty - 6, 12, 12, QPen(QColor("#FFFFFF"), 2), QBrush(tech_color))
            dot.setZValue(10)

            # Подпись имени техника
            name_parts = tech.get("name", "Техник").split()
            short_name = f"{name_parts[0]} {name_parts[1][:1]}." if len(name_parts) >= 2 else tech.get("name", "Техник")
            name_item = self.scene.addText(short_name, QFont("Segoe UI", 8, QFont.Weight.Bold))
            name_item.setDefaultTextColor(QColor("#FFFFFF"))
            name_item.setPos(tx - 25, ty + 10)
            name_item.setZValue(11)

            # Линия пути к целевой стоянке (если назначен)
            target_stand = tech.get("target_stand")
            if target_stand and target_stand in stands_dict:
                st = stands_dict[target_stand]
                path_pen = QPen(tech_color, 2, Qt.PenStyle.DashLine)
                p_line = self.scene.addLine(tx, ty, st["x"], st["y"], path_pen)
                p_line.setZValue(5)
