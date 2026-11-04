// Barcode pictures and label sheets for items (EAN-13 or Code 128, drawn as SVG so they print sharp),
// and scanning with the phone camera where the browser can read barcodes.
import { useEffect, useRef, useState } from 'react';
import type { CompanyBooks } from '../api.ts';
import { useI18n, useLocalName } from '../i18n.tsx';
import { fmt } from '../money.ts';
import { barcodeModules } from '../../../src/books/barcode.ts';
import { printPdf } from '../print/Print.tsx';

/** The bars of a code; `height` in the SVG's own units (one module wide). */
export function BarcodeSvg({ code, height = 40, className }: { code: string; height?: number; className?: string }) {
  let m: string;
  try { m = barcodeModules(code).modules; } catch { return null; }
  const quiet = 10, bars: [number, number][] = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== '1') continue;
    let j = i; while (m[j + 1] === '1') j++;
    bars.push([i, j - i + 1]); i = j;
  }
  return (
    <svg className={className ?? 'barcode'} viewBox={`0 0 ${m.length + quiet * 2} ${height}`} preserveAspectRatio="none" role="img" aria-label={code}>
      <rect width={m.length + quiet * 2} height={height} fill="#fff" />
      {bars.map(([x, w]) => <rect key={x} x={x + quiet} y={0} width={w} height={height} fill="#000" />)}
    </svg>
  );
}

export interface LabelItem { id: string; sku: string; barcode: string; name: string; nameAr: string | null; salePrice: string | null; unit: string }

/** A sheet of labels (3 across on A4): company, item name, bars, the code in digits, and the price when there is one. */
function LabelSheet({ books, labels, local }: { books: CompanyBooks; labels: { item: LabelItem; copies: number }[]; local: (en: string, ar: string | null) => string }) {
  const all = labels.flatMap((l) => Array.from({ length: l.copies }, () => l.item));
  return (
    <div className="label-sheet">
      {all.map((i, n) => (
        <div key={n} className="label">
          <div className="label-co">{local(books.company.name, books.company.nameAr ?? null)}</div>
          <div className="label-name">{local(i.name, i.nameAr)}</div>
          <BarcodeSvg code={i.barcode} height={34} />
          <div className="label-code">{i.barcode}</div>
          <div className="label-foot"><span>{i.sku}</span>{i.salePrice && <b>{books.company.currency} {fmt(i.salePrice)}</b>}</div>
        </div>
      ))}
    </div>
  );
}

/** Opens the print window with labels; at most 600 on one run. */
export function usePrintLabels(books: CompanyBooks) {
  const { t } = useI18n();
  const local = useLocalName();
  return (labels: { item: LabelItem; copies: number }[]) => {
    let left = 600;
    const capped = labels.map((l) => { const c = Math.max(0, Math.min(left, Math.ceil(l.copies))); left -= c; return { ...l, copies: c }; }).filter((l) => l.copies > 0);
    if (!capped.length) return;
    void printPdf(t('wh.labelsTitle'), () => <LabelSheet books={books} labels={capped} local={local} />);
  };
}

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
const Ctor = () => (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
/** Whether this browser can read barcodes with the camera (Chrome on Android, Safari 17+ on iPhone with the setting on). */
export const canScanWithCamera = () => Boolean(Ctor() && navigator.mediaDevices?.getUserMedia);

/** The camera view: reads one code and hands it back; Close or Escape stops the camera. */
export function CameraScan({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let stream: MediaStream | null = null, timer = 0, live = true;
    const C = Ctor();
    if (!C) { setErr(t('wh.cameraNo')); return; }
    const detector = new C({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(async (s) => {
      if (!live) { s.getTracks().forEach((x) => x.stop()); return; }
      stream = s;
      if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => undefined); }
      const tick = async () => {
        if (!live || !video.current) return;
        try {
          const found = await detector.detect(video.current);
          if (found[0]?.rawValue) { onCode(found[0].rawValue); return; }
        } catch { /* the next frame */ }
        timer = window.setTimeout(() => void tick(), 250);
      };
      void tick();
    }).catch(() => setErr(t('wh.cameraDenied')));
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { live = false; clearTimeout(timer); stream?.getTracks().forEach((x) => x.stop()); document.removeEventListener('keydown', esc); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card cam" role="dialog" aria-label={t('wh.camera')}>
      {err ? <div className="notice warn">{err}</div> : <video ref={video} muted playsInline />}
      <div className="actions"><span className="small mut">{err ? '' : t('wh.cameraHint')}</span><span className="spacer" /><button className="b" onClick={onClose}>{t('wh.close')}</button></div>
    </div>
  );
}
