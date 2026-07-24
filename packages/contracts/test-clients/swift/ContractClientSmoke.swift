import OpenAPIRuntime

enum ContractClientSmoke {
    static func acceptGeneratedClient(_ client: Client) -> any APIProtocol {
        client
    }

    static func acceptLiveHealthOutput(
        _ output: Operations.GetLiveHealth.Output
    ) {
        _ = output
    }
}
