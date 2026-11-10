// Cloudflare's custom hostnames and DNS for the e2e stack (decision 0006): the services' in-memory
// fake, one per isolate, shared by the app Worker and the control host. Nothing in the suite
// reaches Cloudflare.
import { FakeDomains } from "@portifact/services/testing";

export const e2eDomains = new FakeDomains();
