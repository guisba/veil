# VEIL — P2P Privacy & QR (v2.2)

Aplicativo de criptografia e comunicação WebRTC entre pares. **Sem hospedagem pública do aplicativo**: `index.html` pode ser aberto localmente em navegadores compatíveis.

> **Aviso:** protótipo experimental. Não garante anonimato absoluto, invisibilidade ao provedor de internet, apagamento forense, sigilo futuro de aplicação ou proteção contra análise avançada de tráfego. Não passou por auditoria independente. Não use como única proteção para comunicações de alto risco.

## Como executar

1. Abra `index.html` em um navegador compatível com JavaScript, WebCrypto e WebRTC. Em iPhone/Android, a abertura local de HTML pode não oferecer todas as APIs; utilize um navegador com as permissões necessárias.
2. Entre em **Chat P2P direto** e crie uma sala.
3. Mostre o QR Code ao convidado, ou compartilhe o convite por um canal confiável. **O QR/convite contém a chave secreta da sala**.
4. No segundo dispositivo, abra sua própria cópia do VEIL, entre na sala pelo QR (quando o navegador oferecer leitura nativa) ou cole o convite.
5. Com conexão estabelecida, troque mensagens e arquivos criptografados. Mensagens de leitura única exigem que o remetente permaneça conectado.

**Redes distintas:** negociação automática por broker MQTT sobre WSS, com SDP/ICE cifrados. STUN é útil para NAT; para redes restritivas pode ser necessário um serviço TURN/TLS, configurado separadamente. `relay-only` reduz a exposição do IP do participante ao par, mas não o oculta do relay, broker, provedor de internet ou administradores da rede. A conectividade real entre redes distintas ainda não foi verificada neste ambiente.

## Estrutura

| Arquivo | Função |
| --- | --- |
| `index.html` | Aplicativo final em um único arquivo, sem CDN. |
| `source_base.html` | Base do aplicativo de criptografia offline. |
| `p2p.html` / `p2p.css` / `p2p.js` | Interface e lógica de comunicação P2P. |
| `auto_transport.js` | Código de referência para negociação automática WSS. |
| `qr_vendor.js` | Gerador QR incorporado; licenças em `LICENSE_QR_VENDOR.txt`. |
| `build.py` | Reconstrói `index.html` a partir dos arquivos-fonte (Python padrão). |
| `build_qr_vendor.py` | Gerador/transformador auxiliar do código QR. |
| `tests/*.cjs` | Testes de protocolo, negociação simulada e privacidade (Node.js 20+). |

## Desenvolvimento

A interface é um HTML autônomo; não é necessário instalar bibliotecas, servidor HTTP nem `npm` para utilizá-la.

Para reconstruir e executar os testes:

```sh
python3 build.py
node tests/protocol.test.cjs
node tests/auto.test.cjs
node tests/privacy.test.cjs
```

Para Windows, substitua `python3` por `py` quando apropriado.

## Limites de privacidade

- A criptografia de transporte WebRTC usa DTLS; os payloads das mensagens usam AES-256-GCM.
- Brokers WSS públicos ou privados são usados para encontrar o outro dispositivo; não hospedam as mensagens de chat, mas podem observar metadados de conexão.
- O tráfego de cobertura e o padding de tamanho reduzem apenas alguns sinais observáveis; **não oferecem camuflagem garantida**.
- Leitura única é uma função do aplicativo, não impede capturas de tela, gravações ou cópias fora do VEIL.
- Uma credencial/QR vazada dá acesso à sala. Nunca inclua segredos reais de salas no repositório, Issues ou screenshots.

## Segurança e testes

Veja [`SECURITY.md`](SECURITY.md). Em 11/11/2026, passaram os três conjuntos de testes Node do projeto (WebCrypto real, WebRTC e broker simulados). Não houve, nesta preparação do repositório, teste físico em iPhone/Android, broker real, TURN real ou auditoria independente.

## Licenças

As bibliotecas de QR de terceiros estão sujeitas às condições em [`LICENSE_QR_VENDOR.txt`](LICENSE_QR_VENDOR.txt). **Não é concedida uma licença geral explícita aos demais arquivos deste repositório.**
