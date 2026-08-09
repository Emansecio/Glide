# Design: apresentação profissional do Glide

## Objetivo

Transformar o repositório GitHub em uma página oficial e profissional para a extensão Glide, sem afirmar que ela já está publicada na Chrome Web Store.

## Escopo

- Reescrever o topo e a estrutura do `README.md` em português claro, com resumo em inglês quando útil para descoberta.
- Apresentar o produto, seus recursos reais, arquitetura resumida, instalação local e estado atual.
- Incluir screenshots já existentes no repositório para tornar a interface concreta.
- Atualizar `package.json` com descrição, autor e palavras-chave mais coerentes com o posicionamento público.
- Ajustar a descrição e os tópicos do repositório GitHub, se a API autenticada permitir.

## Mensagem principal

Glide é uma extensão de navegador com painel lateral para automação assistida por IA. O usuário conversa com o agente, que navega, lê e interage com abas através de ferramentas controladas e observáveis.

## Estrutura do README

1. Hero com nome, proposta, estado “local/unpacked” e links rápidos.
2. Screenshots da interface clara, escura e do fluxo de atividade.
3. O que a extensão faz.
4. Como funciona, com diagrama curto.
5. Recursos e provedores suportados.
6. Segurança e limites operacionais.
7. Instalação local e comandos de validação.
8. Estado do projeto e próximos passos, sem prometer Web Store.
9. Arquitetura, documentação e licença.

## Critérios de sucesso

- Um visitante entende o produto e seu estado em menos de um minuto.
- Nenhuma capacidade inexistente ou publicação futura é apresentada como disponível.
- O README continua reproduzível para quem quer instalar a extensão localmente.
- Build, typecheck e testes permanecem inalterados e passam após a edição.
