// VENDORED near-connect wallet manifest — reviewed 2026-11-05 from hot-dao/near-selector
// repository/manifest.json (manifest version 1.1.0). Only two wallets, each executor pinned to an
// immutable commit (the upstream manifest points at mutable branches):
//   - near-cli: near/near-cli-connect@2b8c4fd — shows the near-cli command; the owner runs it in a
//     terminal (key stays in the OS keychain) and pastes the tx hash back. No key enters the browser.
//   - meteor-wallet: Meteor-Wallet/meteor_wallet_sdk@ef1be35.
// Intear is omitted: its executor is served from its own domain and cannot be pinned.
// Re-vendor deliberately (and record it in BUILD-START-VERIFICATION); never point at a branch.

export const WALLET_MANIFEST = {
  "version": "1.1.0",
  "wallets": [
    {
      "id": "meteor-wallet",
      "name": "Meteor Wallet",
      "icon": "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/meteor-logo-svg.svg",
      "description": "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
      "website": "https://meteorwallet.app/",
      "version": "1.1.1",
      "executor": "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/ef1be35fc3712f2de60a7563aed543d78e73f763/storage/meteor-near-connect-latest.js",
      "type": "sandbox",
      "features": {
        "signMessage": true,
        "signInWithoutAddKey": true,
        "signInAndSignMessage": true,
        "signAndSendTransaction": true,
        "signAndSendTransactions": true,
        "signInWithFunctionCallKey": true,
        "signDelegateActions": true,
        "mainnet": true,
        "testnet": true
      },
      "platform": {
        "web": "https://wallet.meteorwallet.app",
        "chrome": "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
        "android": "https://play.google.com/store/apps/details?id=app.meteorwallet.v2",
        "ios": "https://apps.apple.com/us/app/meteor-wallet/id6739558223"
      },
      "permissions": {
        "storage": true,
        "allowsOpen": [
          "https://chromewebstore.google.com",
          "https://wallet.meteorwallet.app",
          "https://meteorwallet.app",
          "meteorwallet://",
          "meteorwalletdev://"
        ],
        "external": [
          "meteorCom",
          "meteorComV2"
        ]
      }
    },
    {
      "id": "near-cli",
      "name": "NEAR CLI",
      "icon": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%231a1a2e'/%3E%3Cpolyline points='18 40 28 30 18 20' fill='none' stroke='%2300d4aa' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='32' y1='42' x2='46' y2='42' stroke='%2300d4aa' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E",
      "description": "Sign transactions using near-cli-rs in your terminal",
      "website": "https://near.cli.rs",
      "version": "1.0.0",
      "executor": "https://raw.githubusercontent.com/near/near-cli-connect/2b8c4fdc5da03d7e6688a7f84ebce99e480c9c26/dist/near-cli.js",
      "type": "sandbox",
      "platform": {},
      "features": {
        "signMessage": true,
        "signInWithoutAddKey": true,
        "signInAndSignMessage": true,
        "signAndSendTransaction": true,
        "signAndSendTransactions": true,
        "signDelegateActions": true,
        "signInWithFunctionCallKey": true,
        "mainnet": true,
        "testnet": true
      },
      "permissions": {
        "storage": true,
        "clipboardWrite": true
      }
    }
  ]
} as const;
