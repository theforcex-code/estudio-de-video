# Logo 3D girando nas paredes da Entrada (forma-N)

Guia para gerar os vídeos **forma-1 a forma-4** do pacote `pacote-seedance/entrada-paredes/` (ver `ENTRADA-PAREDES.md`, seção 3), **sem IA**: o logo é o modelo 3D da marca, renderizado no Blender, girando uma volta em 5 s no lugar da Forma. Foi assim que fizemos o gel e o couvert, e o resultado foi aprovado.

Por que não gerar a Forma no Seedance: testamos com as 4 vistas do logo e o modelo deformou o anel (virou rosca oval, "8", giro irregular). No Blender, o formato é exato, o giro é constante e o laço fecha perfeito.

---

## 1. O que entregar

| Arquivo | Conteúdo |
|---|---|
| `pacote-seedance/saida/forma-1.mp4` … `forma-4.mp4` | a parede N inteira (6410 × 1150), parada, com só o logo dando **uma volta completa em 5 s** no lugar da Forma |
| `pacote-seedance/saida/forma-posicao.json` | onde está o logo em cada parede (x, y, largura, altura em 6410 × 1150), para recortar a faixa |

- MP4 H.264, **30 q/s**, sem áudio, **150 quadros** = uma volta. O quadro 150 seria igual ao 0: o vídeo repete sem emenda.
- O resto da imagem fica **idêntico** à parede (é a própria imagem, parada).

---

## 2. O que já está pronto (nesta pasta)

| Caminho | O que é |
|---|---|
| `blender/logo.glb` (ou o caminho em `LOGO_GLB`) | o modelo 3D do logo |
| `blender/logo_blender.py` | o script do Blender: importa o .glb, aplica o gel, a ondulação aprovada e renderiza a volta |
| `entrada-sem-forma/parede-N-sem-forma.png` | as 4 paredes `-horizonte43` **sem a Forma** (SAM 2 + LaMa, céu refeito em degradê), 6410 × 1150 |
| `entrada-sem-forma/parede-N-mascara-forma.png` | a máscara da Forma original de cada parede |
| `entrada-sem-forma/parede-4-mascara-fita.png` | a fita grande da parede 4, que passa pelo anel (fica **na frente** do logo) |
| `gel/rgb`, `gel/sil` | uma volta já renderizada (120 quadros, 24 q/s, 1024 px), só para referência de visual |
| `logo3d.py` | a montagem usada nos vídeos do estúdio (gel e couvert), para referência |

Blender: `C:/Program Files/Blender Foundation/Blender 5.1/blender.exe` (GPU OptiX, RTX 3090).

---

## 3. Onde fica o logo em cada parede (6410 × 1150)

Medido nas máscaras da Forma original. O logo tem a **mesma altura** da Forma. O quadro do render é quadrado, de lado `L = altura × 1254 / 964` (o logo ocupa 964/1254 da altura do quadro).

| Parede | centro x | centro y | altura da Forma | lado L do quadro |
|---|---|---|---|---|
| 1 | 5466 | 407 | 748 | 973 |
| 2 | 5490 | 418 | 749 | 974 |
| 3 | 5467 | 413 | 736 | 957 |
| 4 | 5471 | 412 | 726 | 944 |

Sugestão: use **o mesmo centro e tamanho nas 4** (por exemplo, a média: centro 5474, 413; L = 962), para o logo não pular de lugar quando a parede troca.

---

## 4. Passo a passo

### 4.1 Fundo do render (por parede)

Recorte de `parede-N-sem-forma.png` um quadrado de lado L centrado no logo. Onde o quadrado passa do topo da imagem, complete espelhando (reflect). Salve como `fundo-N.png`. O vidro refrata esse fundo, então o mar e o céu aparecem de verdade através do logo.

### 4.2 Render da volta (cor + recorte)

Parâmetros aprovados (versão "B corrigida": a faixa ondula de leve, sem riscos):

```
BLURG=1 ROLL=0 WAVE=35 NWAVE=1 BULGE=0.06 KT=1 SMOOTH=60
TRANS=1 ROUGH=0.03 COR=1,0.5,0.38 WORLD=1.0
RES=1024 FRAMES=150 SAMPLES=160
```

Cor (com o fundo):
```
set BG=C:\...\fundo-N.png
blender -b -P blender/logo_blender.py -- volta <pasta>/rgb-N
```
Recorte (silhueta, mesmos parâmetros de deformação, sem BG):
```
set SIL=1
blender -b -P blender/logo_blender.py -- volta <pasta>/sil-N
```
São 150 PNGs em cada pasta (`0000.png` … `0149.png`). A volta é `360° × f / 150`, então o quadro 150 seria o 0.

Cuidados que aprendemos:
- `ROLL=0` e `WAVE=35`: a faixa só ondula. Rolar a faixa inteira (ROLL) cruzava as camadas e fazia riscos.
- O script limpa as normais gravadas do .glb e suaviza a linha central. Sem isso, a faixa ondulada aparece riscada.
- `YAW0=0` deixa o logo de frente no quadro 0, como a Forma das paredes.

### 4.3 Montagem (por quadro)

1. Parede = `parede-N-sem-forma.png`.
2. Redimensione o render (`rgb-N/f`) e a silhueta (alfa de `sil-N/f`, desfoque 0,6 px) para L × L e cole no lugar (canto = centro − L/2), usando o alfa.
3. **Parede 4:** depois de colar o logo, recoloque a fita por cima. O alfa é `parede-4-mascara-fita.png` menos a máscara da Forma, com borda suave, e os pixels vêm da parede original `-horizonte43`. Assim a fita passa **na frente** do logo.
4. Grave os 150 quadros a 30 q/s, H.264 (crf 16, yuv420p).

### 4.4 Conferir

- O logo não sai do lugar nem muda de tamanho.
- Quadro 0 ≈ quadro 149 + um passo (a volta fecha).
- Nenhuma marca da Forma antiga em volta do logo.
- **Parede 4:** a limpeza deixou um risco horizontal curto no céu, junto da fita de cima (por volta de x 5400–5700, y 120). Se aparecer fora do logo, apague com LaMa nesse ponto.

---

## 5. Na parede final

O logo do forma-N é desenhado para ficar **por cima** da base e das trocas, recortado pela faixa do `forma-posicao.json`, com borda suave. Como o logo é sempre o mesmo modelo, na mesma posição e com a volta fechada, ele pode girar sem parar o ato inteiro (desacelerado 2,5×, se quiser) e trocar de parede sem salto.

Para os vídeos de troca (gel), o logo deve ficar **atrás das fitas**. No estúdio usamos a cor para isso: a fita rosa e os brilhos das fitas transparentes voltam por cima (`logo3d.py`, função `fitas`).
