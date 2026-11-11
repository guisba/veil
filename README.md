# VEIL — P2P Privacy & QR (v2.2)

Conversa P2P cifrada por convite ou QR Code, envelopes protegidos por senha, leitura única local e chaves pós-quânticas, em **um único arquivo HTML**. Sem hospedagem pública do aplicativo: `index.html` pode ser aberto localmente em navegadores compatíveis.

> **Aviso:** protótipo experimental. Não garante anonimato absoluto, invisibilidade ao provedor de internet, apagamento forense, sigilo futuro de aplicação ou proteção contra análise avançada de tráfego. Não passou por auditoria independente. Não use como única proteção para comunicações de alto risco.

## Como executar

1. Abra `index.html` em um navegador com JavaScript, WebCrypto e WebRTC. Em iPhone/Android, a abertura local de HTML pode não oferecer todas as APIs; use um navegador com as permissões necessárias ou sirva o arquivo por HTTPS.
2. Em **Conversa**, escolha **Criar sala**.
3. Mostre o QR Code ao convidado ou envie o convite por um canal em que você confia. **O QR/convite contém a chave secreta da sala.**
4. No segundo dispositivo, abra a própria cópia do VEIL, escolha **Entrar com convite** e cole o convite, ou escaneie o QR (quando o navegador tiver leitor nativo).
5. Compare o **código de verificação** nos dois lados. Com o canal autenticado, o véu sobre a conversa se abre: troque mensagens e arquivos (até 5 MiB). Mensagens de leitura única (botão `1×`) exigem que o remetente continue conectado.

As outras seções funcionam sem rede: **Envelope** (proteger/abrir mensagens e arquivos com senha), **Leitura única** (cofre local no navegador), **Chaves** (ML-KEM, quando o navegador suporta), **Verificar** (formato e hash) e **Guia**.

**Redes distintas:** a negociação usa um broker MQTT sobre WSS, com SDP/ICE cifrados. STUN ajuda com NAT; redes restritivas podem exigir um TURN/TLS configurado por você. O modo "somente relay" evita expor seu IP ao contato, mas não ao relay, ao broker, ao provedor ou aos administradores da rede.

## Interface

- **Dois temas** (escuro e claro). Segue o sistema; a escolha manual é a única preferência gravada (`localStorage`).
- **Indicador de rede** permanente: mostra se há alguma conexão aberta (nenhuma, broker de encontro, canal P2P).
- **Desktop, tablet e celular:** barra lateral no desktop; no celular, barra inferior, painéis "Sala/Conversa" e composer que acompanha o teclado.
- **Teclado e leitores de tela:** link para pular ao conteúdo, foco visível, setas nos seletores, diálogo do leitor de QR com foco contido e `Esc`, regiões `aria-live` para estado e erros.
- **Movimento:** uma linguagem só — o conteúdo é "descoberto" por um véu; o véu da conversa fecha e abre conforme o canal. Respeita `prefers-reduced-motion`.
- **Tipografia:** Recursive (variável, eixos `MONO` e `wght`), embutida no arquivo. Texto cifrado em monoespaçado, texto aberto em proporcional.

## Estrutura

| Caminho | Função |
| --- | --- |
| `index.html` | Aplicativo final em um único arquivo, sem CDN. Gerado por `build.py`. |
| `src/template.html` | Marcação da interface. |
| `src/styles.css` | Sistema de design: tokens, componentes, temas, responsividade, movimento. |
| `src/ui.js` | Camada de apresentação (navegação, temas, avisos, diálogo, véu em canvas). Não toca em chaves nem em rede. |
| `src/core.js` | Estúdio de criptografia local: envelope VEIL1, PBKDF2/HKDF, ML-KEM, cofre de leitura única. |
| `src/p2p.js` | Conversa P2P: convite, broker WSS, WebRTC, AES-GCM de aplicação, leitura única, arquivos, QR. |
| `src/qr_vendor.js` | Gerador de QR embutido; licenças em `LICENSE_QR_VENDOR.txt`. |
| `assets/` | Fonte Recursive (subconjunto latino) e sua licença OFL. |
| `build.py` | Monta `index.html` a partir de `src/` (Python padrão, saída determinística). |
| `tests/*.cjs` | Testes de protocolo, negociação simulada e privacidade (Node.js 20+, sem dependências). |
| `tests/e2e/` | Teste opcional em navegador real (Playwright): dois contextos, WebRTC real, broker WSS local. |

O formato do envelope, a derivação de chaves, o protocolo P2P, a sinalização e o comportamento de leitura única são os mesmos da versão 2.2 original; a reformulação é de interface. A CSP ganhou apenas `font-src data:` para a fonte embutida.

## Desenvolvimento

Usar o aplicativo não exige instalar nada. Para reconstruir e testar:

```sh
python3 build.py
node tests/protocol.test.cjs
node tests/auto.test.cjs
node tests/privacy.test.cjs
```

Teste opcional em navegador (requer `openssl` e baixa o Chromium do Playwright):

```sh
cd tests/e2e && npm install && npx playwright install chromium
node run.cjs            # FAST=1 pula a espera de 30 s · THEME=dark|light
```

No Windows, troque `python3` por `py` quando necessário.

## Limites de privacidade

- A criptografia de transporte WebRTC usa DTLS; os payloads das mensagens usam AES-256-GCM.
- Brokers WSS públicos ou privados servem para encontrar o outro dispositivo; não hospedam as mensagens, mas podem observar metadados de conexão.
- Tráfego de cobertura e preenchimento de tamanho reduzem apenas alguns sinais observáveis; **não oferecem camuflagem garantida**.
- Leitura única é uma função do aplicativo: não impede capturas de tela, gravações ou cópias fora do VEIL.
- Um convite/QR vazado dá acesso à sala. Nunca inclua segredos reais de salas no repositório, em Issues ou em screenshots.

## Segurança e testes

Veja [`SECURITY.md`](SECURITY.md). O que foi e o que não foi verificado nesta versão:

- **Verificado (Node):** os três conjuntos `tests/*.cjs` (WebCrypto real; WebRTC e broker simulados).
- **Verificado (Chromium real, `tests/e2e`):** criação de sala, QR decodificado por leitor independente, entrada por convite, canal WebRTC real autenticado, broker sem texto legível, mensagens nos dois sentidos, leitura única, arquivo de 700 KiB com SHA-256, recusa de arquivo grande, queda e reconexão. Além disso: envelope ida e volta, senha errada, cofre de leitura única, hash, autoteste, navegação por teclado e auditoria axe-core (WCAG 2 A/AA) nos dois temas.
- **Não verificado:** dispositivos físicos iPhone/Android, Safari e Firefox, brokers públicos reais, STUN/TURN reais e redes distintas, leitura de QR pela câmera (o Chromium de teste não tem `BarcodeDetector`), ML-KEM (indisponível no navegador de teste) e auditoria independente.

## Licenças

O gerador de QR de terceiros segue [`LICENSE_QR_VENDOR.txt`](LICENSE_QR_VENDOR.txt). A fonte Recursive segue a SIL Open Font License 1.1 ([`assets/LICENSE_RECURSIVE_OFL.txt`](assets/LICENSE_RECURSIVE_OFL.txt)). **Não é concedida uma licença geral explícita aos demais arquivos deste repositório.**
