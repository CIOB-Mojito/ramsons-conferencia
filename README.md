# RAMSONS Conferência

Aplicação web para **conferência (contagem) de estoque** a partir de planilhas Excel. Cada
operador abre uma conferência, percorre os produtos registrando o que foi contado e, ao
finalizar, o resultado vai para o histórico. O sistema suporta **múltiplas conferências
abertas** por usuário, **histórico**, **contas com perfis (ADM/USUARIO)** e funciona
**offline** quando hospedado em rede local.

---

## Funcionalidades

- **Importação de Excel** (`.xlsx`/`.xls`) via [SheetJS](https://sheetjs.com/) local
  (`vendor/xlsx.full.min.js`, sem CDN).
- **Múltiplas conferências abertas** por usuário, cada uma identificada por um ID próprio.
- **Contagem** produto a produto, com status (pendente/ok/divergente) e totais.
- **Histórico** de conferências finalizadas, com resumo por conferência.
- **Contas e perfis**: `ADM` e `USUARIO`, autenticação por PIN.
- **Painel administrativo**: criar, renomear, redefinir PIN, alterar perfil e excluir
  usuários, além de **carregar uma conferência para outro usuário**.
- **Alteração do próprio PIN** pelo usuário.
- **Armazenamento local** persistido em disco (pasta `data/`), sem banco de dados externo.
- **Canal WebSocket** (`/ws`) disponível no servidor (mensagens `ping`/`echo`/`broadcast`).
  > **Observação:** esse canal **não está integrado ao estado da interface**. A aplicação
  > **não** sincroniza dados em tempo real via WebSocket; as telas obtêm e enviam dados pela
  > API REST e pelo armazenamento local. O WebSocket serve apenas como canal genérico de
  > presença/eco, sem reflexo automático na UI.

---

## Requisitos

- **Node.js 18+** (usa `crypto.scryptSync`, `fetch` e APIs modernas do Node).
- **npm**.
- Navegador moderno (Chrome, Edge, Firefox ou Safari) no computador ou celular.

---

## Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/CIOB-Mojito/ramsons-conferencia.git
cd ramsons-conferencia

# 2. Instale as dependências (Express e ws)
npm install
```

---

## Configuração

A aplicação funciona sem configuração para uso local. Opcionalmente:

| Variável de ambiente | Padrão               | Descrição                                              |
| -------------------- | -------------------- | ------------------------------------------------------ |
| `PORT`               | `3000`               | Porta HTTP/WebSocket do servidor.                      |
| `RCONF_DATA_DIR`     | `./data`             | Pasta de dados (contas, sessões, conferências, etc.). |

A pasta de dados é criada automaticamente na primeira execução, caso não exista.

---

## Execução

```bash
npm start
# ou
node server.js
```

Ao iniciar, o terminal exibe os endereços:

```
  Local:     http://localhost:3000
  Rede (...):  http://<ip-da-maquina>:3000
  Status:    http://localhost:3000/api/status
  WebSocket: ws://<ip>:3000/ws
```

Abra `http://localhost:3000` no navegador. Para uso em rede local (celulares), acesse o
endereço de **Rede** exibido no terminal.

### Contas padrão (seed)

Na primeira execução são criadas duas contas de demonstração:

| Usuário    | PIN    | Perfil  |
| ---------- | ------ | ------- |
| `Ismael`   | `1234` | ADM     |
| `Anderson` | `1234` | USUARIO |

> **Importante:** os PINs são armazenados com **scrypt + salt** (nunca em texto puro).
> Troque os PINs padrão e redefina-os no painel administrativo antes de usar em produção.

---

## Formato da planilha Excel

A planilha deve conter, no cabeçalho, **três colunas obrigatórias**:

| Código | Descrição | Quantidade |
| ------ | --------- | ---------- |
| 100001 | Parafuso  | 250        |
| 100002 | Porca     | 180        |

- Os nomes das colunas são reconhecidos de forma flexível (ex.: `Código`, `cod`, `SKU`,
  `referencia`; `Descrição`, `desc`, `produto`, `item`; `Quantidade`, `Qtd`, `estoque`,
  `saldo`).
- Linhas sem código são ignoradas; códigos duplicados são reportados.
- A soma da coluna **Quantidade** vira o total esperado da conferência.

---

## Estrutura do projeto

```
ramsons-conferencia/
├── server.js               # Backend Express + WebSocket e API REST
├── rconf-local-store.js    # Persistência em disco (contas, sessões, conferências)
├── rconf-store.js          # Camada de armazenamento/uso no frontend (offline/local)
├── rconf-flow.js           # Regras de cálculo da conferência
├── rconf-excel.js          # Importação de planilhas (SheetJS)
├── rconf-api.js            # Cliente HTTP da API
├── rconf-resume.js         # Retomada da conferência em andamento (painel inicial)
├── rconf-ui.css            # Estilos
├── index.html              # Login
├── home.html               # Painel inicial / lista de conferências
├── nova-conferencia.html   # Criar conferência (importar Excel)
├── conferencia.html        # Contagem
├── resumo.html             # Resumo de uma conferência
├── historico.html          # Conferências finalizadas
├── perfil.html             # Perfil / troca de PIN
├── opcoes.html             # Opções
├── usuarios.html           # Lista de usuários (ADM)
├── usuario.html            # Detalhe/gestão de usuário + carregar conferência (ADM)
├── vendor/                 # Bibliotecas locais (SheetJS, three.js)
├── public/                 # Pasta estática opcional (atualmente vazia)
├── package.json
└── data/                   # (NÃO versionado) dados locais gerados em tempo de execução
```

---

## Dados e privacidade

- Toda a persistência fica em `data/` (contas, sessões, conferências, histórico).
- **A pasta `data/` não é versionada** (veja `.gitignore`): ela é criada automaticamente e
  contém dados operacionais reais, que não devem ser publicados.
- Os PINs são guardados como hash scrypt + salt; as sessões ficam em `data/.sessions.json`.

---

## Segurança

- Antes de expor a aplicação em rede, altere os PINs padrão.
- O servidor escuta em `0.0.0.0`; para uso restrito, ajuste `HOST` em `server.js` ou use um
  firewall/proxy reverso.

---

## Licença

Defina a licença conforme a necessidade da organização.
