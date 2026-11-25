import { AirportMap } from '../map/AirportMap';
import { nearestWaypoint } from '../../lib/waypoints';
import { useEffect, useState } from 'react';
import { AlertOctagon, Send, MapPin, ArrowUp, ArrowDown, X } from 'lucide-react';
import { useOps, act } from '../../store/ops';
import { Button, Field, Modal, Switch, toast } from '../../components/ui';
import { errorText, get } from '../../lib/api';
import { cx } from '../../lib/format';

const TEMPLATES = [
  { text: 'Утечка гидравлики на основной стойке', qual: 'Планер' },
  { text: 'Повреждение обшивки, требуется осмотр', qual: 'Планер' },
  { text: 'Вибрация двигателя на запуске', qual: 'Двигатель' },
  { text: 'Не запускается ВСУ', qual: 'Двигатель' },
  { text: 'Отказ радиостанции VHF', qual: 'Авионика' },
  { text: 'Ошибка навигационного комплекса', qual: 'Авионика' },
];

export function NewRequestModal({ open, stand, onClose, onCreated }: { open: boolean; stand?: string; onClose(): void; onCreated(id: number): void }) {
  const airport = useOps(s => s.airport);
  const state = useOps(s => s.state);
  const [f, setF] = useState<{ stand: string; description: string; qual: string; extra: string; tech_id: number | null }>({ stand: '', description: '', qual: 'auto', extra: '', tech_id: null });
  const [em, setEm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [via, setVia] = useState<string[]>([]);
  useEffect(() => {
    if (open) setF({ stand: stand || state?.aircraft.find(a => a.status === 'parked')?.stand || airport?.stands[0]?.id || '', description: '', qual: 'auto', extra: '', tech_id: null });
    if (open) setEm(false);
    if (open) { setVia([]); setPicking(false); }
  }, [open, stand]);
  const aircraft = state?.aircraft.find(a => a.stand === f.stand && a.status === 'parked');
  const [quals, setQuals] = useState<string[]>([]);
  useEffect(() => { if (open) get('/api/meta').then(data => setQuals(data.quals)).catch(e => toast.bad(errorText(e))); }, [open]);

  async function submit() {
    if (!f.description.trim()) { toast.bad('Опишите неисправность'); return; }
    setBusy(true);
    try {
      const res: any = await act.createRequest({ ...f, via: via.filter(Boolean), priority: em ? 'emergency' : 'normal' });
      const requestId = Number(res?.id ?? res?.request?.id);
      toast.ok('Заявка создана в очереди', `Заявка #${requestId}`);
      onCreated(requestId);
      onClose();
    } catch (e) { toast.bad(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} eyebrow="Новая работа" title="Создать заявку" width={picking ? 900 : 540}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant={em ? 'danger' : 'primary'} icon={<Send size={16} />} loading={busy} onClick={submit}>{em ? 'Создать ЧС' : 'Создать заявку'}</Button></>}>
      <div className="row-2">
        <Field label="Стоянка" hint={aircraft ? <span className="t-green">{aircraft.flight} · {aircraft.model}</span> : 'Борт на стоянке отсутствует'}>
          <select value={f.stand} onChange={e => setF(v => ({ ...v, stand: e.target.value }))}>
            {airport?.stands.map(s => { const a = state?.aircraft.find(x => x.stand === s.id && x.status === 'parked'); return <option key={s.id} value={s.id}>{s.id}{a ? ` · ${a.flight}` : ''}</option>; })}
          </select>
        </Field>
        <Field label="Квалификация">
          <input list="request-quals" maxLength={100} placeholder="Определить по описанию" value={f.qual === 'auto' ? '' : f.qual} onChange={e => setF(v => ({...v, qual:e.target.value}))} />
          <datalist id="request-quals">{quals.map(q => <option key={q} value={q} />)}</datalist>
        </Field>
      </div>
      <Field label="Неисправность">
        <textarea rows={3} value={f.description} onChange={e => setF(v => ({ ...v, description: e.target.value }))} placeholder="Что случилось с бортом?" autoFocus />
      </Field>
      <Field label="Промежуточные точки" hint="Инженер пройдёт их в указанном порядке перед прибытием на заявку.">
        <Button icon={<MapPin size={16}/>} onClick={() => setPicking(value => !value)}>{picking ? 'Скрыть карту' : via.length ? 'Изменить точки на карте' : 'Выбрать на карте'}</Button>
      </Field>
      {picking && <section className="waypoint-picker">
        <p className="muted small">Нажимайте на дороги ВДНХ. Номера показывают порядок прохождения. Карту можно перемещать и приближать.</p>
        <div className="waypoint-map"><AirportMap compact selection={{request:null,tech:null,aircraft:null,stand:f.stand || null}} waypoints={via}
          onReady={engine => engine.fitAll()}
          onPoint={(x,y) => {
            if (!airport) return;
            if (via.length >= 32) { toast.bad('Можно выбрать не больше 32 точек'); return; }
            const node=nearestWaypoint(airport,x,y,state?.blocked ?? []);
            if (!node) { toast.info('Нажмите ближе к доступной дороге, при необходимости приблизьте карту'); return; }
            if (via.includes(node.id)) { toast.info('Эта точка уже добавлена'); return; }
            setVia(items => [...items,node.id]);
          }} /></div>
        <div className="row-2"><span className="muted small">Выбрано: {via.length} / 32</span><Button onClick={() => setPicking(false)}>Готово</Button></div>
      </section>}
      {via.length > 0 && <ol className="waypoint-list">{via.map((id,index) => {
        const node=airport?.nodes.find(n => n.id===id);
        const nearby=node && airport?.areas?.map(area => {
          const count=area.points.length || 1;
          const x=area.points.reduce((sum,p)=>sum+p[0],0)/count,y=area.points.reduce((sum,p)=>sum+p[1],0)/count;
          return {name:area.name,distance:Math.hypot(x-node.x,y-node.y)};
        }).filter(a=>a.name && a.distance<150).sort((a,b)=>a.distance-b.distance)[0]?.name;
        const move=(offset:number)=>setVia(items=>{const next=[...items];[next[index],next[index+offset]]=[next[index+offset],next[index]];return next;});
        return <li key={id}><b>{index+1}</b><span>Точка {index+1}{nearby && <small>Рядом: {nearby}</small>}</span>
          <button type="button" disabled={index===0} aria-label={`Точку ${index+1} раньше`} onClick={()=>move(-1)}><ArrowUp size={16}/></button>
          <button type="button" disabled={index===via.length-1} aria-label={`Точку ${index+1} позже`} onClick={()=>move(1)}><ArrowDown size={16}/></button>
          <button type="button" aria-label={`Удалить точку ${index+1}`} onClick={()=>setVia(items=>items.filter(item=>item!==id))}><X size={16}/></button>
        </li>;
      })}</ol>}
      <div className="chips templates">{TEMPLATES.map(t => <button key={t.text} type="button" className="chip" onClick={() => setF(v => ({ ...v, description: t.text, qual: t.qual }))}>{t.text}</button>)}</div>
      <Field label="Дополнительно"><input value={f.extra} onChange={e => setF(v => ({ ...v, extra: e.target.value }))} placeholder="Необязательно: наблюдения экипажа, код ошибки" /></Field>
      <label className={cx('em-toggle', em && 'on')}><AlertOctagon size={18} /><span><b>Чрезвычайная ситуация</b><small>Наивысший приоритет, ближайший инженер даже вне норматива</small></span><Switch checked={em} onChange={setEm} label="ЧС" /></label>
    </Modal>
  );
}
