# GTA Clips AI — protótipo 0.1

Aplicação web local para enviar um vídeo autorizado, transcrever o áudio, pedir à IA que selecione cinco momentos e renderizar cortes verticais com legendas.

## Requisitos
- Node.js 20 ou superior
- FFmpeg e FFprobe instalados e disponíveis no PATH
- Chave de API da OpenAI com faturamento/configuração habilitados

## Instalação
1. Extraia o ZIP.
2. Abra um terminal dentro da pasta `gta-clips-ai`.
3. Execute `npm install`.
4. Copie `.env.example` para `.env` e adicione sua chave em `OPENAI_API_KEY`.
5. Execute `npm start`.
6. Abra `http://localhost:3000` no navegador.

## Como usar
Envie um arquivo de vídeo que você tenha direito de editar. O sistema extrai o áudio, transcreve em português, solicita à IA cinco momentos e renderiza MP4 vertical com legendas.

## Limitações conhecidas desta primeira versão
- O MVP recebe arquivos locais; ainda não importa diretamente links do YouTube.
- A escolha dos momentos usa principalmente o conteúdo falado/transcrito. Momentos puramente visuais ou sem fala podem não ser identificados bem.
- O corte vertical central pode não manter o personagem/ação sempre no centro; rastreamento inteligente de câmera fica para a próxima versão.
- A transcrição usa `whisper-1` porque a API oferece timestamps por segmento nesse formato. A documentação da OpenAI marca esse modelo como depreciado com encerramento previsto para 26/02/2027. Antes de publicar o produto, migre para um fluxo de transcrição com timestamps suportado na época.
- A chave da API fica somente no servidor, nunca no navegador. Não publique o `.env`.
- Para vídeos longos, o processamento pode demorar e gerar custos de API e renderização.

## Direitos e privacidade
Use somente vídeos próprios, licenciados ou cujo titular tenha autorizado a edição. Os arquivos enviados ficam temporariamente nas pastas locais `uploads`, `work` e `outputs`; configure limpeza e armazenamento seguro antes de hospedar publicamente.
