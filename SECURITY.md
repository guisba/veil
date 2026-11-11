# Segurança do VEIL

O VEIL é um protótipo experimental de mensageria criptografada. **Não foi auditado de forma independente e não oferece anonimato absoluto nem desaparecimento garantido de rastros**.

## Relato responsável de vulnerabilidades

Não publique chaves, convites ou detalhes de explorações envolvendo usuários reais em Issues públicas. Em um repositório privado, comunique o proprietário usando um canal privado escolhido por ele. Se os *Private vulnerability reports* estiverem habilitados nas configurações do repositório, prefira esse canal.

## Modelo de ameaça — limites

- WebRTC/DTLS e AES-256-GCM protegem conteúdo contra observação passiva, dependendo da implementação, das chaves e da integridade dos participantes.
- A operadora de rede, broker WSS, servidor TURN, sistema operacional e/ou navegador ainda podem observar metadados.
- Convites e QR Codes contêm dados suficientes para entrar na sala e devem ser protegidos como segredos.
- O software não substitui serviços auditados com proteção robusta de identidade, Double Ratchet e encaminhamento anônimo.
- Mensagens de leitura única não podem eliminar cópias, gravações, screenshots ou vestígios mantidos por terceiros.

## Estado de verificação

Testes automatizados Node disponíveis em `tests/`. São testes de regressão, não prova de segurança criptográfica; em especial, o estabelecimento de pares na suíte é simulado.

`tests/e2e/` traz um teste opcional em Chromium real (dois contextos isolados, WebRTC real, broker WSS local). Ele verifica o fluxo de ponta a ponta e que nada legível passa pelo broker, mas roda em uma única máquina: não cobre redes distintas, STUN/TURN, brokers públicos nem dispositivos físicos.

## Interface e superfície de ataque

- A reformulação da interface não alterou o formato do envelope, a derivação de chaves, o protocolo P2P, a sinalização nem a leitura única.
- A CSP continua sem `default-src`, sem scripts ou estilos remotos; foi acrescentado apenas `font-src data:` para a fonte embutida no próprio arquivo.
- O convite aparece desfocado até você pedir para vê-lo, e o QR só é desenhado enquanto o painel está aberto; ao ocultar, o canvas é limpo. Isso reduz exposição acidental na tela, não é uma proteção criptográfica.
- A única preferência gravada pelo aplicativo é o tema (`localStorage`). O título da aba pode mostrar a contagem de mensagens não lidas, nunca o conteúdo.
