## SafeTimelockModule

- Contracts located at `/contracts`

### Setup

```
yarn install
```

### Env

Copy `.env.example` to `.env` and add your test private keys

### Tests

```bash
yarn run test
```

### Coverage

```bash
yarn run coverage
```

### To deploy the contract:

```bash
npx hardhat run scripts/00-deploy-timelock-module.ts --network somniaTestnet
```

### To setup the module:

```bash
npx hardhat run scripts/01-module-setup.ts --network somniaTestnet
```

### To queue a transaction:

```bash
OPERATION=queue npx hardhat run --network somniaTestnet scripts/02-manage-transactions.ts
```

### To cancel a transaction:

```bash
OPERATION=cancel npx hardhat run --network somniaTestnet scripts/02-manage-transactions.ts
```

### To execute a transaction:

```bash
OPERATION=execute npx hardhat run --network somniaTestnet scripts/02-manage-transactions.ts
```
