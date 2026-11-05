# Estúdio de vídeo

Estúdio local com um quadro de nodes para gerar vídeos pelo [ArgoLink](https://argolink.io): imagens de início e fim, prompt, modelo, resolução e duração em cada node, e depois juntar, deixar em câmera lenta e aplicar efeitos.

Cada pessoa gera com **a própria chave do ArgoLink**, e o custo de cada geração vai para a conta dessa chave.

## Modelos

| Modelo | Resoluções | Preço por segundo (US$) |
|---|---|---|
| Seedance 2.0 Mini | 480p, 720p | 0,0299 a 0,0643 |
| Seedance 2.0 Fast | 480p, 720p | 0,0478 a 0,103 |
| Seedance 2.0 | 480p a 4K | 0,0598 a 0,661 |
| Seedance 2.5 | 480p a 1080p | 0,0874 a 0,483 |
| Grok Imagine Video 1.5 | 480p, 720p | 0,032 a 0,056 |
| MiniMax H3 | 768p, 2K | 0,039 a 0,064 |

Os preços estão em [`public/models.mjs`](public/models.mjs). Confira no ArgoLink antes de gerar, porque podem mudar. O estúdio mostra o custo e pede confirmação antes de cada geração.

## Como usar

1. Instale o [Node.js](https://nodejs.org) 20 ou mais novo.
2. Baixe o repositório e instale a dependência (o ffmpeg vem junto):
   ```bash
   git clone https://github.com/theforcex-code/estudio-de-video.git
   cd estudio-de-video
   npm install
   ```
3. Coloque a sua chave do ArgoLink. Copie `CHAVE-ARGOLINK.exemplo.txt` para `CHAVE-ARGOLINK.txt` e cole a chave (começa com `sk-`). Outra opção é definir a variável `ARGOLINK_API_KEY`. Esse arquivo nunca vai para o GitHub.
4. Inicie o estúdio:
   ```bash
   npm start
   ```
5. Abra http://localhost:4321.

As imagens enviadas ficam em `uploads/` e os vídeos gerados em `videos-gerados/`, dentro da pasta do estúdio. Para usar outra pasta de vídeos, defina `ESTUDIO_VIDEOS`. A porta muda com `PORT`.

## Convidar alguém para gerar com o seu saldo

A pessoa convidada não precisa instalar nada nem ter chave: ela abre um link no navegador e usa o seu estúdio, com o seu saldo do ArgoLink.

1. Baixe o `cloudflared-windows-amd64.exe` em [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) e salve como `ferramentas/cloudflared.exe`.
2. Com o estúdio ligado, rode `npm run compartilhar`. O link aparece na tela e já fica copiado.
3. Mande o link. Ele traz um código de acesso (`?acesso=…`): sem o código, quem chega pela internet vê só uma página de bloqueio. No seu próprio computador nada muda.

O link funciona enquanto o computador, o estúdio e a janela do `compartilhar` estiverem abertos, e o endereço muda cada vez que você roda o comando. Não há limite de gasto: quem tiver o link pode gerar até acabar o saldo. Para cortar o acesso de todos, apague `ACESSO.txt` e rode de novo (sai um código novo).

## O que funciona só com o Node

- Gerar vídeos no ArgoLink com first frame, last frame, referências e prompt
- Modo parede larga: a imagem é colocada numa faixa e o vídeo é recortado de volta no formato original
- Juntar vídeos (com laço e transição), ajustar velocidade, cor e desfoque, tirar quadros

## Ferramentas opcionais (Windows, com placa de vídeo)

Esses nodes precisam de programas que não vêm no repositório, por serem grandes. Coloque cada um em `ferramentas/`:

| Pasta | Para quê | Onde baixar |
|---|---|---|
| `ferramentas/rife-ncnn-vulkan-…-windows/` | Câmera lenta com quadros intermediários | [rife-ncnn-vulkan](https://github.com/nihui/rife-ncnn-vulkan/releases) |
| `ferramentas/realesrgan/` | Ampliar vídeos (upscale) | [Real-ESRGAN ncnn vulkan](https://github.com/xinntao/Real-ESRGAN/releases) |
| `ferramentas/py/` | Ambiente Python do Logo 3D e do Travar fundo | `python -m venv ferramentas/py`, depois `pip install numpy opencv-python pillow torch` e o [SAM 2](https://github.com/facebookresearch/sam2) |
| `ferramentas/modelos/` | Pesos do SAM 2 (`sam2.1_hiera_large.pt`) | [SAM 2](https://github.com/facebookresearch/sam2) |

O node **Logo 3D** também precisa dos quadros do logo já renderizados no Blender (pastas de render em `ferramentas/logo3d/`), que não estão no repositório. Os scripts do Blender estão em `ferramentas/logo3d/blender/`, e o passo a passo está em [`COMO-FAZER-O-LOGO.md`](ferramentas/logo3d/COMO-FAZER-O-LOGO.md).

## Arquivos

- `server.mjs`: servidor local, que conversa com o ArgoLink e roda o ffmpeg
- `public/`: a interface do quadro de nodes
- `cutout.mjs`, `forma-movel.mjs`, `rife.mjs`: recorte, apagar forma em movimento e câmera lenta
- `ferramentas/logo3d/`, `ferramentas/travar/`: scripts Python do Logo 3D e do Travar fundo
