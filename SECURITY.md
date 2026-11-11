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
