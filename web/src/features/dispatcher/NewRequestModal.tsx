import { useEffect, useState } from 'react';
import { AlertOctagon, Send } from 'lucide-react';
import { useOps, act } from '../../store/ops';
import { Button, Field, Modal, Switch, toast } from '../../components/ui';
import { errorText } from '../../lib/api';
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
  const [f, setF] = useState({ stand: '', description: '', qual: 'auto', extra: '' });
  const [em, setEm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF({ stand: stand || state?.aircraft.find(a => a.status === 'parked')?.stand || airport?.stands[0]?.id || '', description: '', qual: 'auto', extra: '' });
    if (open) setEm(false);
  }, [open, stand]);
  const aircraft = state?.aircraft.find(a => a.stand === f.stand && a.status === 'parked');

  async function submit() {
    if (!f.description.trim()) { toast.bad('Опишите неисправность'); return; }
    setBusy(true);
    try {
      const res: any = await act.createRequest({ ...f, priority: em ? 'emergency' : 'normal' });
      toast.ok(res?.request?.tech_name ? `Назначен ${res.request.tech_name}` : 'Заявка в очереди', `Заявка #${res?.id ?? ''}`);
      onCreated(Number(res?.id ?? res?.request?.id));
      onClose();
    } catch (e) { toast.bad(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} eyebrow="Новая работа" title="Создать заявку" width={540}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant={em ? 'danger' : 'primary'} icon={<Send size={16} />} loading={busy} onClick={submit}>{em ? 'Создать ЧС' : 'Создать и назначить'}</Button></>}>
      <div className="row-2">
        <Field label="Стоянка" hint={aircraft ? <span className="t-green">{aircraft.flight} · {aircraft.model}</span> : 'Борт на стоянке отсутствует'}>
          <select value={f.stand} onChange={e => setF(v => ({ ...v, stand: e.target.value }))}>
            {airport?.stands.map(s => { const a = state?.aircraft.find(x => x.stand === s.id && x.status === 'parked'); return <option key={s.id} value={s.id}>{s.id}{a ? ` · ${a.flight}` : ''}</option>; })}
          </select>
        </Field>
        <Field label="Квалификация">
          <select value={f.qual} onChange={e => setF(v => ({ ...v, qual: e.target.value }))}>
            <option value="auto">Определить по описанию</option><option>Планер</option><option>Двигатель</option><option>Авионика</option>
          </select>
        </Field>
      </div>
      <Field label="Неисправность">
        <textarea rows={3} value={f.description} onChange={e => setF(v => ({ ...v, description: e.target.value }))} placeholder="Что случилось с бортом?" autoFocus />
      </Field>
      <div className="chips templates">{TEMPLATES.map(t => <button key={t.text} type="button" className="chip" onClick={() => setF(v => ({ ...v, description: t.text, qual: t.qual }))}>{t.text}</button>)}</div>
      <Field label="Дополнительно"><input value={f.extra} onChange={e => setF(v => ({ ...v, extra: e.target.value }))} placeholder="Необязательно: наблюдения экипажа, код ошибки" /></Field>
      <label className={cx('em-toggle', em && 'on')}><AlertOctagon size={18} /><span><b>Чрезвычайная ситуация</b><small>Наивысший приоритет, ближайший инженер даже вне норматива</small></span><Switch checked={em} onChange={setEm} label="ЧС" /></label>
    </Modal>
  );
}
