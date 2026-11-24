<?php
/**
 * Nusuh Books website: one small form handler for Contact, Book a demo,
 * Confirm payment and Order. Sends the message to hello@ through Resend.
 *
 * - The Resend key is NEVER in this file or in the repository. It lives in a
 *   secrets file (see config.local.php.example). Without it the handler answers
 *   "not configured" and sends nothing.
 * - Order totals are recomputed here from data/pricing.json. Whatever total the
 *   browser shows is ignored.
 * - Spam: hidden honeypot field, link-stuffing check, per-visitor and overall
 *   rate limits, same-site check, size limits.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function out(int $status, array $body): never {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

/* ---------- settings (secrets are read from outside the web folder first) ---------- */
function settings(): array {
    $cfg = [];
    foreach ([dirname(__DIR__, 2) . '/nusuh-website-secrets.php', __DIR__ . '/config.local.php'] as $f) {
        if (is_file($f)) { $c = require $f; if (is_array($c)) { $cfg = $c; break; } }
    }
    $env = fn(string $k) => getenv($k) !== false && getenv($k) !== '' ? getenv($k) : null;
    return [
        'resend_key' => trim((string)($env('RESEND_API_KEY') ?? ($cfg['resend_key'] ?? ''))),
        'from'       => trim((string)($env('MAIL_FROM') ?? ($cfg['from'] ?? ''))),
        'api_url'    => (string)($env('RESEND_API_URL') ?? ($cfg['api_url'] ?? 'https://api.resend.com/emails')),
        'rate_dir'   => (string)($env('RATE_DIR') ?? ($cfg['rate_dir'] ?? (sys_get_temp_dir() . '/nusuh-site-rate'))),
    ];
}

function data(string $name): array {
    $raw = @file_get_contents(__DIR__ . '/data/' . $name);
    $j = $raw ? json_decode($raw, true) : null;
    if (!is_array($j)) { error_log("nusuh-site: cannot read data/$name"); out(500, ['ok' => false, 'error' => 'server']); }
    return $j;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { header('Allow: POST'); out(405, ['ok' => false, 'error' => 'method']); }

/* same-site only */
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    $oh = parse_url($origin, PHP_URL_HOST);
    $host = preg_replace('/:\d+$/', '', (string)($_SERVER['HTTP_HOST'] ?? ''));
    if (!$oh || strcasecmp($oh, $host) !== 0) out(403, ['ok' => false, 'error' => 'origin']);
}
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 7 * 1024 * 1024) out(413, ['ok' => false, 'error' => 'too_large']);

/* ---------- helpers ---------- */
function field(string $k, int $max): string {
    $v = $_POST[$k] ?? '';
    if (!is_string($v)) return '';
    $v = preg_replace('/[^\P{C}\n\t]/u', '', str_replace("\r", '', $v)) ?? '';   // drop control characters
    $v = trim($v);
    return mb_substr($v, 0, $max);
}
function oneLine(string $s): string { return trim(preg_replace('/\s+/u', ' ', $s) ?? ''); }
function fail(string $field): never { out(422, ['ok' => false, 'error' => 'invalid', 'field' => $field]); }
function validEmail(string $e): bool { return strlen($e) <= 160 && (bool)filter_var($e, FILTER_VALIDATE_EMAIL); }
function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

$cfg = settings();
$forms = data('forms.json');

/* ---------- honeypot: pretend success, send nothing ---------- */
if (field('website', 200) !== '') out(200, ['ok' => true]);

/* ---------- rate limit: per visitor and overall ---------- */
function visitorIp(): string {
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
        if (!empty($_SERVER[$k])) { return trim(explode(',', (string)$_SERVER[$k])[0]); }
    }
    return 'unknown';
}
function rateLimited(string $dir, string $key, int $max, int $windowSeconds): bool {
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $file = $dir . '/' . hash('sha256', $key) . '.json';
    $now = time(); $hits = [];
    $fh = @fopen($file, 'c+');
    if (!$fh) return false;                       // never block real people because of a disk problem
    flock($fh, LOCK_EX);
    $raw = stream_get_contents($fh);
    $arr = $raw ? json_decode($raw, true) : [];
    foreach (is_array($arr) ? $arr : [] as $t) if (is_int($t) && $t > $now - $windowSeconds) $hits[] = $t;
    $limited = count($hits) >= $max;
    if (!$limited) $hits[] = $now;
    ftruncate($fh, 0); rewind($fh); fwrite($fh, json_encode($hits)); fflush($fh); flock($fh, LOCK_UN); fclose($fh);
    return $limited;
}
$ip = visitorIp();
if (rateLimited($cfg['rate_dir'], "ip10m:$ip", 5, 600) || rateLimited($cfg['rate_dir'], "ip1d:$ip", 30, 86400) || rateLimited($cfg['rate_dir'], 'all1h', 200, 3600)) {
    out(429, ['ok' => false, 'error' => 'rate']);
}

/* ---------- validate by form type ---------- */
$type = field('type', 20);
if (!in_array($type, ['contact', 'demo', 'payment', 'order'], true)) fail('type');
$email = field('email', 160);
if (!validEmail($email)) fail('email');

$replyName = '';
$rows = [];            // label => value, for the message body
$attachments = [];
$subjectBase = $forms['subjects'][$type] ?? 'Website form';

switch ($type) {
    case 'contact':
        $name = field('name', 120); $message = field('message', 4000);
        if ($name === '') fail('name');
        if (mb_strlen($message) < 3) fail('message');
        if (preg_match_all('~https?://~i', $message) > 2) out(200, ['ok' => true]);   // link-stuffed: quietly drop
        $replyName = $name;
        $rows = ['Name' => $name, 'Email' => $email, 'Message' => $message];
        break;

    case 'demo':
        $name = field('name', 120); $company = field('company', 160); $team = field('teamSize', 60);
        if ($name === '') fail('name');
        if ($company === '') fail('company');
        $replyName = $name;
        $rows = ['Name' => $name, 'Email' => $email, 'Company and industry' => $company, 'Team size' => $team];
        break;

    case 'payment':
        $company = field('company', 160); $invoice = field('invoice', 60); $amount = field('amount', 30);
        $date = field('date', 20); $reference = field('reference', 160);
        if ($company === '') fail('company');
        if ($invoice === '') fail('invoice');
        if (!preg_match('/^[0-9][0-9,]*(\.[0-9]{1,2})?$/', $amount)) fail('amount');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || !checkdate((int)substr($date, 5, 2), (int)substr($date, 8, 2), (int)substr($date, 0, 4))) fail('date');
        $replyName = $company;
        $rows = ['Company name' => $company, 'Email' => $email, 'Invoice number' => $invoice, 'Amount paid (SAR)' => $amount, 'Date of transfer' => $date, 'Bank and reference used' => $reference];
        $f = $_FILES['receipt'] ?? null;
        if (is_array($f) && ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
            if ($f['error'] !== UPLOAD_ERR_OK || $f['size'] > 5 * 1024 * 1024 || !is_uploaded_file($f['tmp_name'])) fail('receipt');
            $mime = (new finfo(FILEINFO_MIME_TYPE))->file($f['tmp_name']);
            $ext = ['application/pdf' => 'pdf', 'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime] ?? null;
            if (!$ext) fail('receipt');
            $attachments[] = ['filename' => 'transfer-receipt.' . $ext, 'content' => base64_encode((string)file_get_contents($f['tmp_name']))];
        }
        break;

    case 'order':
        $company = field('company', 120);
        if ($company === '') fail('company');
        $pricing = data('pricing.json'); $mods = data('modules.json');
        $known = []; foreach ($mods['optional'] as $m) $known[$m['id']] = $m['name'];
        $picked = [];
        foreach (array_filter(explode(',', field('modules', 400))) as $id) {
            $id = trim($id);
            if (!isset($known[$id])) fail('modules');
            $picked[$id] = true;
        }
        $cleanup = field('cleanup', 1) === '1';
        $oneTime = (int)$pricing['implementation'] + ($cleanup ? (int)$pricing['cleanup'] : 0);
        $yearly = (int)$pricing['annualCore'] + (int)$pricing['perModule'] * count($picked);
        $cur = (string)$pricing['currency'];
        $money = fn(int $n) => $cur . ' ' . number_format($n);
        $lines = ['One-time', 'Implementation (six core modules): ' . $money((int)$pricing['implementation'])];
        if ($cleanup) $lines[] = 'Accounts clean-up and setup: ' . $money((int)$pricing['cleanup']);
        $lines[] = 'One-time total: ' . $money($oneTime);
        $lines[] = '';
        $lines[] = 'Every year';
        $lines[] = 'Annual fee: ' . $money((int)$pricing['annualCore']);
        foreach (array_keys($picked) as $id) $lines[] = 'Extra module, ' . $known[$id] . ': ' . $money((int)$pricing['perModule']);
        $lines[] = 'Yearly total: ' . $money($yearly);
        $lines[] = '';
        $lines[] = 'All prices exclude VAT. Payment method: bank transfer.';
        $replyName = $company;
        $rows = ['Company' => $company, 'Contact email' => $email, 'Order' => implode("\n", $lines)];
        break;
}

/* ---------- send through Resend ---------- */
if ($cfg['resend_key'] === '' || $cfg['from'] === '') {
    error_log('nusuh-site: Resend key or sender address is not configured; nothing was sent.');
    out(503, ['ok' => false, 'error' => 'not_configured']);
}

$subject = oneLine($subjectBase . ($replyName !== '' ? ' - ' . mb_substr($replyName, 0, 60) : ''));
$text = ''; $html = '<table style="font-family:Arial,sans-serif;font-size:15px;border-collapse:collapse">';
foreach ($rows as $label => $value) {
    if ($value === '') continue;
    $text .= $label . ": " . $value . "\n\n";
    $html .= '<tr><td style="padding:6px 14px 6px 0;vertical-align:top;color:#4A6270;white-space:nowrap">' . h($label) . '</td><td style="padding:6px 0">' . nl2br(h($value)) . '</td></tr>';
}
$html .= '</table>';

$payload = [
    'from' => $cfg['from'],
    'to' => [$forms['to']],
    'reply_to' => $email,
    'subject' => $subject,
    'text' => rtrim($text) . "\n",
    'html' => $html,
];
if ($attachments) $payload['attachments'] = $attachments;

$ch = curl_init($cfg['api_url']);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $cfg['resend_key'], 'Content-Type: application/json', 'User-Agent: nusuh-website/1.0'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT => 20,
]);
$resp = curl_exec($ch);
$code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$cerr = curl_error($ch);
curl_close($ch);

if ($resp === false || $code < 200 || $code >= 300) {
    error_log('nusuh-site: Resend failed (HTTP ' . $code . ') ' . ($cerr !== '' ? $cerr : substr((string)$resp, 0, 300)));
    out(502, ['ok' => false, 'error' => 'send_failed']);
}
out(200, ['ok' => true]);
