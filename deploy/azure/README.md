# Deploy of the AI cloud service on Azure

`deploy.ps1` publishes `cloud/server.ts` to Azure Container Apps with **internal** ingress
(reachable only from MedFlow-Backend, never from the internet). It uses only Azure CLI: no Docker
is needed on the machine that runs it.

```powershell
# from the MedFlow-AI folder, after `az login`
.\deploy\azure\deploy.ps1 -Registry <registry-name>
```

It asks for `GEMINI_API_KEY` (hidden input) and stores it as a Container Apps secret.
Add `-BuildLocally` when Docker Desktop runs on the same machine: the script then builds the
image, pushes it to the registry (`az acr login` + `docker push`) and deploys it in one go.

**Run this script first**, then the one in MedFlow-Backend, which needs the AI service address.

The full guide (who does what, how the images are uploaded, costs, common errors) is in
**`MedFlow-Backend/deploy/azure/README.md`**.
