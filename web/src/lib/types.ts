export type Role = 'dispatcher' | 'engineer';

export interface User {
  id: number;
  email: string;
  username: string;
  name: string;
  bio: string;
  avatar_color: string;
  role: Role;
  status: string;
  qual: string | null;
  types: string[];
  base: string | null;
  tech_id: number | null;
  on_shift: boolean;
  created_at: string;
  approved_at: string | null;
}

export type Point = [number, number];

export interface Candidate {
  tech_id: number;
  name: string;
  dist: number | null;
  eta: number | null;
  eta_walk?: number | null;
  mode?: 'walk' | 'vehicle';
  vehicle_name?: string;
  reason?: string;
  delay?: number;
  path?: Point[];
}

export type RequestStatus = 'waiting' | 'assigned' | 'enroute' | 'arrived' | 'working' | 'done' | 'cancelled';

export interface Request {
  id: number;
  stand: string;
  description: string;
  extra: string;
  note: string;
  qual: string;
  priority: 'low' | 'normal' | 'high' | 'emergency' | 'critical';
  status: RequestStatus;
  status_ru: string;
  tech_id: number | null;
  tech_name: string | null;
  aircraft_id: number | null;
  flight: string | null;
  created_at: string;
  created_sim: number;
  arrived_sim: number | null;
  done_sim: number | null;
  elapsed: number;
  eta: number | null;
  eta_left: number | null;
  response_sec?: number | null;
  violation: boolean;
  travel_mode?: string;
  vehicle_id?: number | null;
  route_available?: boolean;
  candidates?: Candidate[];
  version: number;
}

export interface Technician {
  speed_kmh?: number | null;
  speed_source?: 'gps' | 'simulation';
  speed_limit_kmh?: number | null;
  id: number;
  name: string;
  qual: string;
  types: string[];
  base: string;
  speed: number;
  status: 'free' | 'busy';
  on_shift: boolean;
  request_id: number | null;
  route: Point[];
  route_available?: boolean;
  vehicle_id: number | null;
  x: number;
  y: number;
}

export interface EngineerLocation {
  tech_id: number; user_id: number; name: string; latitude: number; longitude: number;
  accuracy: number; heading: number | null; speed: number | null; updated_at_ms: number; track: Point[];
}

export interface Aircraft {
  id: number;
  flight: string;
  model: string;
  stand: string | null;
  status: 'inbound' | 'parked' | 'departing';
  status_ru: string;
  heading: number;
  x: number;
  y: number;
  route: Point[];
  services: { kind: string; label?: string; status?: string; progress?: number }[];
  services_progress: number;
  turnaround_progress?: number;
  sched_arr_sim?: number;
  actual_arr_sim?: number | null;
  sched_dep_sim?: number;
  delay_arr_sec?: number;
  brief?: {
    airline?: string;
    registration?: string;
    gate?: string;
    origin?: { iata: string; name: string };
    destination?: { iata: string; name: string };
  };
}

export interface Vehicle {
  id: number;
  name: string;
  status: string;
  status_ru: string;
  x: number;
  y: number;
  heading?: number;
  route: Point[];
  tech_id: number | null;
  request_id: number | null;
  base?: string;
}

export interface ShiftEvent { ts: string; kind: string; text: string }

export interface Stats {
  active: number;
  waiting: number;
  done: number;
  norm_pct: number | null;
  avg_response: number | null;
  techs_free: number;
  techs_total: number;
  aircraft_total: number;
  aircraft_parked: number;
  aircraft_inbound: number;
  aircraft_departing: number;
}

export interface ShiftState {
  account: User;
  /** engineer snapshot: own technician record */
  me?: Technician | null;
  active: Request[];
  requests?: Request[];
  history: Request[];
  techs: Technician[];
  aircraft: Aircraft[];
  vehicles: Vehicle[];
  events: ShiftEvent[];
  registrations: User[];
  blocked: string[];
  stats: Stats;
  norm: number;
  sim_time: number;
  sim_speed: number;
  sim_running: boolean;
  airport_name: string;
  my_request?: Request | null;
}

export interface AirportNode { id: string; x: number; y: number }
export interface AirportEdge { walk_allowed?: boolean; vehicle_allowed?: boolean; blocked?: boolean; id: string; a: string; b: string; length: number; kind?: string; name?: string }
export interface Airport {
  name: string;
  source?: string;
  geo?: { iata?: string; icao?: string; latitude: number; longitude: number; elevation_m?: number; coordinate_source?: string };
  geo_transform?: { origin_latitude: number; origin_longitude: number; meters_per_degree_latitude: number; meters_per_degree_longitude: number };
  width: number;
  height: number;
  nodes: AirportNode[];
  edges: AirportEdge[];
  stands: { id: string; node: string; heading?: number }[];
  bases: { id: string; name: string; node: string }[];
  areas?: { kind: string; name?: string; points: Point[] }[];
  parking?: { points: Point[] }[];
  runways?: { name?: string; width?: number; points: Point[] }[];
}

export interface Meta {
  airport: { name: string; source?: string };
  maps?: { provider: string; configured: boolean };
  bases: { id: string; name: string }[];
  quals: string[];
  types: string[];
  demo?: { enabled: boolean; dispatcher_email: string; dispatcher_password: string; engineer_email: string; engineer_password: string };
}

export interface ChatRoom {
  id: number;
  kind: 'shift' | 'direct';
  name: string;
  peer_id: number | null;
  peer_name: string;
  unread: number;
}

export interface ChatContact {
  id: number;
  name: string;
  username: string;
  qual: string | null;
  on_shift: boolean;
  avatar_color: string;
  bio: string;
  tech_id: number | null;
  online: boolean;
}

export interface ChatMessage {
  id: number;
  room_id: number;
  room_kind: string;
  sender_id: number;
  sender_name: string;
  kind: 'text' | 'sticker' | 'file' | 'voice';
  body: string;
  content: string;
  sticker: string | null;
  media_url: string | null;
  media_name: string | null;
  media_type: string | null;
  duration: number | null;
  read: boolean;
  created_at: string;
  /** client-only */
  pending?: boolean;
  failed?: boolean;
  localKey?: string;
}

export interface RealtimePacket<T = any> {
  protocol: number;
  event_id: string;
  sequence: number;
  occurred_at_ms: number;
  kind: string;
  actor: { user_id: number; role: Role } | null;
  entity: { kind: string; id: string; version: number } | null;
  payload: T;
}
