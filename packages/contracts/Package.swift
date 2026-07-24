// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "ProjectBoothContractSmoke",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-openapi-generator",
            exact: "1.13.0"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-runtime",
            exact: "1.12.0"
        ),
    ],
    targets: [
        .target(
            name: "ContractClientSmoke",
            dependencies: [
                .product(
                    name: "OpenAPIRuntime",
                    package: "swift-openapi-runtime"
                ),
            ],
            path: ".",
            exclude: [
                "README.md",
                "dist",
                "generated",
                "node_modules",
                "openapi-ts.config.mjs",
                "package.json",
                "redocly.yaml",
                "src",
                "test",
                "test-clients/typescript",
                "tsconfig.json",
            ],
            sources: [
                "test-clients/swift/ContractClientSmoke.swift",
            ],
            plugins: [
                .plugin(
                    name: "OpenAPIGenerator",
                    package: "swift-openapi-generator"
                ),
            ]
        ),
    ]
)
