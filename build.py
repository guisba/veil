from pathlib import Path
root=Path(__file__).parent
source=root/'source_base.html'
if not source.exists():
    raise SystemExit('Arquivo source_base.html não encontrado.')
s=source.read_text(encoding='utf-8')
css=(root/'p2p.css').read_text(encoding='utf-8')
view=(root/'p2p.html').read_text(encoding='utf-8')
script=(root/'p2p.js').read_text(encoding='utf-8')
qr=(root/'qr_vendor.js').read_text(encoding='utf-8')
assert s.count('</style>')==1 and s.count('</body>')==1
assert 'data-view="keys"' in s and '<section class="view" id="view-keys"' in s
assert s.count('onceReadFragment();onceCheckServer()')==0
s=s.replace('<title>VEIL 1.4 — Private by design</title>', '<title>VEIL 2.0 — P2P Offline Secure Studio</title>')
s=s.replace("connect-src 'self'", "connect-src wss:")
# Remove the obsolete LAN server flow and all its JavaScript networking functions.
start=s.index('  <div class="once-choice"')
end=s.index('  <section id="once-local-panel"', start)
s=s[:start]+s[end:]
start=s.index('  <section id="once-remote-panel"')
end=s.index('  <div id="once-reveal"', start)
s=s[:start]+s[end:]
s=s.replace("let onceMode='local',onceRevealTimer=null,onceRevealLeft=60;", "let onceRevealTimer=null,onceRevealLeft=60;")
import re
s,n=re.subn(r'(?m)^function onceSwitch\(mode\).*\n','',s); assert n==1
start=s.index('function onceServerUrl(value)')
end=s.index('\nconst wire=()=>{',start)
s=s[:start]+s[end:]
remove_ids=['once-local-tab', 'once-remote-tab', 'once-remote-create', 'once-check-server', 'once-remote-open', 'once-copy-code', 'once-copy-link']
lines=s.splitlines(keepends=True)
s=''.join(line for line in lines if not any(line.startswith("$('"+x+"')") for x in remove_ids))
s=s.replace("if(['http:','https:'].includes(location.protocol))$('once-server').value=location.origin;", '')
s=s.replace("onceReadFragment();if(['http:','https:'].includes(location.protocol))onceCheckServer();", '')

s=s.replace('</style>', css+'\n</style>',1)
nav='''    <button type="button" class="nav-item" data-view="p2p"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><path d="m8 11 8-5M8 13l8 5"/></svg>Chat P2P direto</button>\n'''
s=s.replace('    <button type="button" class="nav-item" data-view="keys"', nav+'    <button type="button" class="nav-item" data-view="keys"',1)
s=s.replace('<section class="view" id="view-keys">', view+'\n<section class="view" id="view-keys">',1)
s=s.replace('Sem conta. Cofre offline.<br>Rede apenas no envio de leitura única.', 'Sem conta, sem hospedagem VEIL.<br>Encontro WSS cifrado.')
s=s.replace('VEIL 1.4 · LOCAL-FIRST CRYPTOGRAPHY','VEIL 2.2 · PRIVATE WEBRTC & E2EE')
s=s.replace('SEM CONTAS · SEM RASTREAMENTO · SERVIDOR LAN OPCIONAL', 'SEM HOSPEDAGEM VEIL · CONVITE ÚNICO · WEBRTC E2EE')
s=s.replace('03 / POST-QUANTUM', '05 / POST-QUANTUM')
s=s.replace('04 / TOOLS', '06 / TOOLS')
s=s.replace('05 / REFERENCE', '07 / REFERENCE')
s=s.replace('PRIVATE WORKSPACE <span class="muted">/ V1.3</span>', 'PRIVATE WORKSPACE <span class="muted">/ V2.0</span>')
s=s.replace('OFFLINE / LOCAL ONE-TIME SERVER', 'OFFLINE / DIRECT P2P CHANNEL')
s=s.replace('Mensagens que somem após uma abertura. Escolha o cofre deste navegador ou compartilhe na sua rede privada. O servidor fica no seu computador: sem nuvem e sem internet.', 'Mensagens locais que são apagadas após a primeira leitura. Para mensagens P2P entre dispositivos, use Chat P2P direto, com encontro cifrado via WSS.')

s=s.replace('A leitura única compartilhada exige que o computador servidor esteja ligado e os dispositivos estejam na mesma rede privada.', 'No chat P2P, ambos os dispositivos devem permanecer conectados até a abertura.')
s=s.replace('O modo compartilhável precisa de servidor VEIL opcional para remover o ciphertext na primeira tentativa de resgate.', 'O chat P2P pode liberar o conteúdo de leitura única somente na primeira solicitação enquanto o remetente estiver online.')
s=s.replace('O modo compartilhável faz requisições exclusivamente ao servidor explicitamente configurado pelo usuário.', 'O chat P2P usa broker externo WSS apenas para negociação cifrada. Mensagens e arquivos seguem pelo WebRTC (direto ou relay TURN).')
# Disable legacy network backend automatically, including #once= deep links; old LAN code is retained for backward compatibility but gated by a CSP that forbids fetch.
s=s.replace('onceRefresh();onceReadFragment();if([\'http:\',\'https:\'].includes(location.protocol))onceCheckServer();', 'onceRefresh();')
s=s.replace('  <div class="once-choice" role="tablist"', '  <div class="once-choice" role="tablist"',1)
s=s.replace('VEIL 2.0 — P2P Offline Secure Studio', 'VEIL 2.2 — P2P Privacy & QR')
s=s.replace('VEIL 2.0 · LOCAL-FIRST & DIRECT P2P', 'VEIL 2.2 · P2P PRIVACY & QR')
s=s.replace('PRIVATE WORKSPACE <span class="muted">/ V2.0</span>', 'PRIVATE WORKSPACE <span class="muted">/ V2.2</span>')
# new P2P code comes after existing script, ensuring original event wiring executes first.
s=s.replace('</body>', '<script>\n'+qr+'\n</script>\n<script>\n'+script+'\n</script>\n</body>',1)
(root/'index.html').write_text(s, encoding='utf-8')
# index.html is the standalone distributable artifact within this repository.
print('Created', len(s.encode('utf-8')), 'bytes')
