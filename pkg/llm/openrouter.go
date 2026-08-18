package llm

// openRouterBaseUrl is baked in rather than left to configuration. OpenRouter
// speaks the OpenAI shape, so naming it as its own provider is what stops an
// OpenRouter key being sent to api.openai.com by an operator who set the
// provider and forgot the URL.
const openRouterBaseUrl = "https://openrouter.ai/api/v1"

// newOpenRouter reuses the OpenAI implementation; only the endpoint differs.
func newOpenRouter(config providerConfig) (provider, error) {
	return newOpenAI(openRouterConfig(config))
}

// openRouterConfig is split out so the defaulting rule is testable without
// reaching into the vendor component's internals. llm_base_url still wins when
// set, so a proxy or a test server can override.
func openRouterConfig(config providerConfig) providerConfig {
	if config.baseUrl == "" {
		config.baseUrl = openRouterBaseUrl
	}

	return config
}
