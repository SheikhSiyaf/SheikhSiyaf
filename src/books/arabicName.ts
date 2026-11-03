// Suggests an Arabic name for a business or person typed in English. Runs offline: no name ever
// leaves the app. Known business words are translated, common names spelled as Saudis and Emiratis
// write them, everything else transliterated; then the words are put in Arabic order:
//   [company type] [name] [للactivity وactivity…] [legal suffix]
//   "Riyadh Supplies Co" -> "شركة الرياض للتوريدات", "Marina Café LLC" -> "مقهى المارينا ذ.م.م"
// It is a suggestion: the person checks and edits it.

/** Words that say what kind of business it is; they go first ("مقهى المارينا"). */
const TYPES: Record<string, string> = {
  company: 'شركة', co: 'شركة', corporation: 'شركة', corp: 'شركة', est: 'مؤسسة', establishment: 'مؤسسة', group: 'مجموعة',
  factory: 'مصنع', office: 'مكتب', center: 'مركز', centre: 'مركز', restaurant: 'مطعم', cafe: 'مقهى', coffee: 'مقهى', hotel: 'فندق',
  bakery: 'مخبز', store: 'متجر', stores: 'متاجر', shop: 'محل', pharmacy: 'صيدلية', clinic: 'عيادة', hospital: 'مستشفى', agency: 'وكالة',
  school: 'مدرسة', academy: 'أكاديمية', institute: 'معهد', salon: 'صالون', workshop: 'ورشة', market: 'سوق', supermarket: 'سوبرماركت',
  bank: 'بنك', firm: 'مكتب', studio: 'استوديو', gallery: 'معرض', showroom: 'معرض', laboratory: 'مختبر', lab: 'مختبر',
};

/** What the business does; they follow the name: "للتجارة", then "والمقاولات". Stored with ال. */
const ACTIVITIES: Record<string, string> = {
  trading: 'التجارة', trade: 'التجارة', contracting: 'المقاولات', contractors: 'المقاولات', construction: 'الإنشاءات',
  industries: 'الصناعات', industrial: 'الصناعات', services: 'الخدمات', service: 'الخدمات', transport: 'النقل', transportation: 'النقل',
  investment: 'الاستثمار', investments: 'الاستثمار', consulting: 'الاستشارات', consultancy: 'الاستشارات', consultants: 'الاستشارات',
  logistics: 'الخدمات اللوجستية', supplies: 'التوريدات', supply: 'التوريدات', wholesale: 'الجملة', telecom: 'الاتصالات',
  telecommunications: 'الاتصالات', communications: 'الاتصالات', technology: 'التقنية', technologies: 'التقنية', tech: 'التقنية',
  marketing: 'التسويق', travel: 'السفر', tourism: 'السياحة', engineering: 'الهندسة', electronics: 'الإلكترونيات', electrical: 'الأدوات الكهربائية',
  food: 'الأغذية', foods: 'الأغذية', steel: 'الحديد', iron: 'الحديد', cement: 'الأسمنت', furniture: 'الأثاث', printing: 'الطباعة',
  advertising: 'الدعاية والإعلان', media: 'الإعلام', import: 'الاستيراد', export: 'التصدير', insurance: 'التأمين', security: 'الحراسات الأمنية',
  cleaning: 'النظافة', maintenance: 'الصيانة', software: 'البرمجيات', textiles: 'المنسوجات', fashion: 'الأزياء', jewellery: 'المجوهرات',
  jewelry: 'المجوهرات', perfumes: 'العطور', cars: 'السيارات', auto: 'السيارات', automotive: 'السيارات', energy: 'الطاقة', oil: 'النفط',
  water: 'المياه', agriculture: 'الزراعة', education: 'التعليم', training: 'التدريب', catering: 'الإعاشة', events: 'تنظيم الفعاليات',
  stationery: 'القرطاسية', plastics: 'البلاستيك', paper: 'الورق', chemicals: 'الكيماويات', equipment: 'المعدات', medical: 'المستلزمات الطبية',
};

/** Legal form; goes last. */
const SUFFIXES: Record<string, string> = { llc: 'ذ.م.م', 'l.l.c': 'ذ.م.م', ltd: 'المحدودة', limited: 'المحدودة', fze: 'م.م.ح', fzco: 'ش.م.ح', jsc: 'ش.م.س', plc: 'ش.م.ع' };

/** Places, common words and names, spelled the usual way. */
const WORDS: Record<string, string> = {
  // food and drink (menu items and kitchen materials)
  tea: 'شاي', karak: 'كرك', coffee: 'قهوة', latte: 'لاتيه', cappuccino: 'كابتشينو', espresso: 'إسبريسو', mocha: 'موكا', juice: 'عصير', water: 'ماء',
  milk: 'حليب', chicken: 'دجاج', beef: 'لحم بقري', lamb: 'لحم ضأن', fish: 'سمك', shrimp: 'روبيان', burger: 'برجر', sandwich: 'ساندويتش', salad: 'سلطة',
  soup: 'شوربة', rice: 'أرز', bread: 'خبز', cheese: 'جبن', eggs: 'بيض', egg: 'بيض', tomato: 'طماطم', tomatoes: 'طماطم', lettuce: 'خس', potato: 'بطاطس',
  potatoes: 'بطاطس', fries: 'بطاطس مقلية', oil: 'زيت', sugar: 'سكر', flour: 'دقيق', cake: 'كيك', pizza: 'بيتزا', pasta: 'باستا', fresh: 'طازج',
  gulf: 'الخليج', desert: 'الصحراء', red: 'الأحمر', sea: 'البحر', east: 'الشرق', eastern: 'الشرقية', west: 'الغرب', western: 'الغربية',
  north: 'الشمال', northern: 'الشمالية', south: 'الجنوب', southern: 'الجنوبية', arabian: 'العربية', arab: 'العربية', saudi: 'السعودية',
  emirates: 'الإمارات', riyadh: 'الرياض', jeddah: 'جدة', dubai: 'دبي', makkah: 'مكة', mecca: 'مكة', madinah: 'المدينة', medina: 'المدينة',
  dammam: 'الدمام', khobar: 'الخبر', abha: 'أبها', tabuk: 'تبوك', qassim: 'القصيم', hail: 'حائل', jubail: 'الجبيل', yanbu: 'ينبع',
  sharjah: 'الشارقة', ajman: 'عجمان', fujairah: 'الفجيرة', oman: 'عمان', muscat: 'مسقط', sohar: 'صحار', salalah: 'صلالة', najd: 'نجد', hejaz: 'الحجاز',
  noor: 'النور', nour: 'النور', amal: 'الأمل', waha: 'الواحة', oasis: 'الواحة', palm: 'النخيل', palms: 'النخيل', city: 'المدينة', star: 'النجمة',
  golden: 'الذهبية', gold: 'الذهب', green: 'الخضراء', blue: 'الزرقاء', white: 'البيضاء', modern: 'الحديثة', new: 'الجديدة', international: 'الدولية',
  national: 'الوطنية', united: 'المتحدة', first: 'الأولى', royal: 'الملكية', global: 'العالمية', future: 'المستقبل', vision: 'الرؤية',
  marina: 'المارينا', tower: 'البرج', towers: 'الأبراج', bay: 'الخليج', crescent: 'الهلال', falcon: 'الصقر', horizon: 'الأفق',
  customer: 'عميل', cash: 'نقدي', walk: '', in: '', the: '', and: '', of: '', for: '', '&': '',   // activities are already joined with و
  olaya: 'العليا', properties: 'العقارية', property: 'العقارية', real: '', estate: 'العقارية', telecom_: '',
  // given and family names
  mohammed: 'محمد', mohammad: 'محمد', muhammad: 'محمد', mohamed: 'محمد', ahmed: 'أحمد', ahmad: 'أحمد', abdullah: 'عبدالله', abdulla: 'عبدالله',
  abdulaziz: 'عبدالعزيز', abdulrahman: 'عبدالرحمن', abdulkarim: 'عبدالكريم', khalid: 'خالد', khaled: 'خالد', omar: 'عمر', umar: 'عمر', ali: 'علي',
  hassan: 'حسن', hasan: 'حسن', hussein: 'حسين', husain: 'حسين', salem: 'سالم', saad: 'سعد', fahad: 'فهد', fahd: 'فهد', sultan: 'سلطان',
  nasser: 'ناصر', nasir: 'ناصر', rashid: 'راشد', rashed: 'راشد', hamad: 'حمد', majid: 'ماجد', majed: 'ماجد', waleed: 'وليد', walid: 'وليد',
  yousef: 'يوسف', yusuf: 'يوسف', youssef: 'يوسف', ibrahim: 'إبراهيم', saleh: 'صالح', salih: 'صالح', turki: 'تركي', faisal: 'فيصل', saud: 'سعود',
  nawaf: 'نواف', bandar: 'بندر', mansour: 'منصور', mansoor: 'منصور', hamza: 'حمزة', karim: 'كريم', kareem: 'كريم', sami: 'سامي', rami: 'رامي',
  tariq: 'طارق', tarek: 'طارق', ziad: 'زياد', zayed: 'زايد', mohsen: 'محسن', yasser: 'ياسر', yaser: 'ياسر', adel: 'عادل', adil: 'عادل',
  fatima: 'فاطمة', fatma: 'فاطمة', aisha: 'عائشة', maryam: 'مريم', mariam: 'مريم', noura: 'نورة', nora: 'نورة', sara: 'سارة', sarah: 'سارة',
  layla: 'ليلى', laila: 'ليلى', hana: 'هناء', huda: 'هدى', reem: 'ريم', mona: 'منى', nadia: 'نادية', amira: 'أميرة', lina: 'لينا', dana: 'دانة',
  otaibi: 'العتيبي', qahtani: 'القحطاني', harbi: 'الحربي', ghamdi: 'الغامدي', zahrani: 'الزهراني', dosari: 'الدوسري', shehri: 'الشهري',
  mutairi: 'المطيري', rajhi: 'الراجحي', subaie: 'السبيعي', shammari: 'الشمري', anazi: 'العنزي', juhani: 'الجهني', malki: 'المالكي',
  hashemi: 'الهاشمي', mansouri: 'المنصوري', nuaimi: 'النعيمي', suwaidi: 'السويدي', maktoum: 'مكتوم', nahyan: 'نهيان', karim_: '',
  haddad: 'حداد', nasser_: '', saeed: 'سعيد', said: 'سعيد', rahman: 'رحمن', jaber: 'جابر', jabir: 'جابر', bakr: 'بكر', othman: 'عثمان', osman: 'عثمان',
};

/** Letter-by-letter spelling for words not in the lists above. */
export function transliterate(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const DI: [string, string][] = [['sh', 'ش'], ['kh', 'خ'], ['gh', 'غ'], ['th', 'ث'], ['dh', 'ذ'], ['ch', 'تش'], ['ph', 'ف'],
    ['oo', 'و'], ['ou', 'و'], ['ee', 'ي'], ['ai', 'اي'], ['ay', 'اي'], ['aa', 'ا'], ['ck', 'ك'], ['qu', 'كو']];
  const ONE: Record<string, string> = { a: 'ا', b: 'ب', c: 'ك', d: 'د', e: 'ي', f: 'ف', g: 'ج', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل',
    m: 'م', n: 'ن', o: 'و', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز' };
  let out = '';
  for (let i = 0; i < w.length;) {
    const two = w.slice(i, i + 2);
    const di = DI.find(([k]) => k === two);
    if (di) { out += di[1]; i += 2; continue; }
    const ch = w[i]!;
    const last = i === w.length - 1;
    if (ch === 'e' && last && w.length > 3) { i++; continue; }                       // silent final e
    if (ch === 'c' && 'eiy'.includes(w[i + 1] ?? '')) { out += 'س'; i++; continue; } // soft c
    if (i === 0 && 'aei'.includes(ch)) { out += 'إ'.replace('إ', ch === 'a' ? 'أ' : 'إ'); i++; continue; }
    if (i === 0 && 'ou'.includes(ch)) { out += 'أو'; i++; continue; }
    if (ch === 'a' && !last && i > 0 && !'aeiou'.includes(w[i - 1]!) && !'aeiou'.includes(w[i + 1] ?? '')) {
      // short "a" between consonants is usually not written ("ahmad" -> "احمد" style); keep it only in short words
      if (w.length > 4) { i++; continue; }
    }
    out += ONE[ch] ?? '';
    i++;
  }
  return out.replace(/(.)\1+/g, '$1');
}

/** Suggested Arabic name for an English business or person name. Empty input gives ''. */
export function suggestArabicName(english: string): string {
  const tokens = english.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[(),]/g, ' ').replace(/[–—-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const types: string[] = [], names: string[] = [], activities: string[] = [], suffixes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!;
    const t = raw.replace(/\.$/, '');
    if (SUFFIXES[t] || SUFFIXES[raw]) { suffixes.push(SUFFIXES[t] ?? SUFFIXES[raw]!); continue; }
    if (TYPES[t]) { if (!types.includes(TYPES[t]!)) types.push(TYPES[t]!); continue; }
    if (ACTIVITIES[t]) { if (!activities.includes(ACTIVITIES[t]!)) activities.push(ACTIVITIES[t]!); continue; }
    if ((t === 'al' || t === 'el') && tokens[i + 1]) {                                   // "Al Noor" -> "النور"
      const next = tokens[++i]!.replace(/\.$/, '');
      const known = WORDS[next];
      names.push(known ? (known.startsWith('ال') ? known : `ال${known}`) : `ال${transliterate(next)}`);
      continue;
    }
    if (t.startsWith('al-') || t.startsWith('el-')) { const rest = t.slice(3); names.push(WORDS[rest]?.startsWith('ال') ? WORDS[rest]! : `ال${WORDS[rest] ?? transliterate(rest)}`); continue; }
    if (t in WORDS) { if (WORDS[t]) names.push(WORDS[t]!); continue; }
    if (/^\d+$/.test(t)) { names.push(t); continue; }
    names.push(transliterate(t));
  }
  // "Red Sea" style pairs: noun after adjective in Arabic.
  const pairs: [string, string, string][] = [['الأحمر', 'البحر', 'البحر الأحمر']];
  for (const [a, b, joined] of pairs) {
    const ia = names.indexOf(a), ib = names.indexOf(b);
    if (ia >= 0 && ib === ia + 1) names.splice(ia, 2, joined);
  }
  const acts = activities.map((a, i) => (i === 0 ? (a.startsWith('ال') ? `لل${a.slice(2)}` : `ل${a}`) : `و${a}`));
  return [...types, ...names, ...acts, ...suffixes].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
