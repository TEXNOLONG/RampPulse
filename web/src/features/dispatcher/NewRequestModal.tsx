import { useEffect, useState } from 'react';
import { AlertOctagon, Send } from 'lucide-react';
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
  const [via, setVia] = useState<string[]>([]);
  useEffect(() => {
    if (open) setF({ stand: stand || state?.aircraft.find(a => a.status === 'parked')?.stand || airport?.stands[0]?.id || '', description: '', qual: 'auto', extra: '', tech_id: null });
    if (open) setEm(false);
    if (open) setVia([]);
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
    <Modal open={open} onClose={onClose} eyebrow="Новая работа" title="Создать заявку" width={540}
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
      {via.map((node, index) => <Field key={index} label={`Промежуточный узел ${index + 1}`}>
        <div className="row-2"><input list="airport-route-nodes" value={node} onChange={e => setVia(items => items.map((item, i) => i === index ? e.target.value : item))} placeholder="Код узла на схеме" /><Button onClick={() => setVia(items => items.filter((_, i) => i !== index))}>Убрать</Button></div>
      </Field>)}
      {via.length < 3 && <Button onClick={() => setVia(items => [...items, ''])}>Добавить точку маршрута</Button>}
      <datalist id="airport-route-nodes">{airport?.nodes.map(node => <option key={node.id} value={node.id}>{Math.round(node.x)}, {Math.round(node.y)}</option>)}</datalist>
      <div className="chips templates">{TEMPLATES.map(t => <button key={t.text} type="button" className="chip" onClick={() => setF(v => ({ ...v, description: t.text, qual: t.qual }))}>{t.text}</button>)}</div>
      <Field label="Дополнительно"><input value={f.extra} onChange={e => setF(v => ({ ...v, extra: e.target.value }))} placeholder="Необязательно: наблюдения экипажа, код ошибки" /></Field>
      <label className={cx('em-toggle', em && 'on')}><AlertOctagon size={18} /><span><b>Чрезвычайная ситуация</b><small>Наивысший приоритет, ближайший инженер даже вне норматива</small></span><Switch checked={em} onChange={setEm} label="ЧС" /></label>
    </Modal>
  );
}
